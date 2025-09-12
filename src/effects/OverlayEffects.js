import * as THREE from 'three';
import { Effect, EffectPass } from 'postprocessing';

// ---------------- Fluted Glass (banded refraction with cylindrical profile) ----------------

export const reededParams = {
  enabled: true,
  rotationDeg: 0.0,             // degrees; 0 -> vertical flutes
  bandTiltDeg: 0.0,             // small extra rotation used only for banding/prismatic feel
  fluteWidthUnit: 'vw',         // 'vw' | '%' | 'px'
  fluteWidthDesktop: 0.7,       // base width at center (in vw/% or px if unit='px') - standard reference
  fluteWidthTablet: 1.6,        // wider on tablet to maintain visibility
  fluteWidthMobile: 3.2,        // much wider on mobile to ensure reeds are clearly visible
  // Flute width variation from center to edges
  fluteWidthCenterScale: 1,   // multiplier at center (1.0 = 100% of base width)
  fluteWidthEdgeScale: 1,     // multiplier at edges (1.0 = 100% of base width)
  refractPx: 12.0,            // base refraction (px) at baseline flute width
  curve: 2.0,                 // base profile exponent: 1=linear, 2=parabolic, >2 stronger near edges
  edgeFeatherPx: 1.0,         // base feather width (px) at baseline flute width
  // Gradient stops as distance from center (0-50% of width)
  gradientStop1Distance: 0.05,    // earlier onset
  gradientStop2Distance: 0.22,    // wider band
  // Effect intensities at each stop
  refractPxStop1: 0.0,
  refractPxStop2: 6.0,
  gradientWhiteStop1: 0.28,
  gradientWhiteStop2: 0.85,
  gradientBlackStop1: 0.04,
  gradientBlackStop2: 0.55,
  // Frost/blur effect intensities at each stop
  frostStop1: 0.0,            // no frost at center
  frostStop2: 3.6,           // stronger blur at edges
  // Depth mask distances (in view-space units: -viewZ); d0 = no effect, d1 = full
  // Use scene-scaled defaults to clearly separate front face vs back
  depthD0: 198.5,
  depthD1: 201.5,
  // Controls
  depthMaskDebug: false,       // when true, visualize depthMask grayscale
  // Split-screen controls for progressive glass coverage
  splitScreenMode: false,      // enable split-screen left/right effect
  splitScreenBoundary: 0.5     // X position (0-1) where effect boundary occurs
};

// Convert responsive flute width to pixels for current canvas width
function computeFluteWidthPx(params, canvasWidthPx){
  const w = Math.max(canvasWidthPx || 0, 1);
  // Breakpoints: <=480 mobile, <=900 tablet, otherwise desktop
  let v;
  if (w <= 480) v = params.fluteWidthMobile ?? params.fluteWidthTablet ?? params.fluteWidthDesktop;
  else if (w <= 900) v = params.fluteWidthTablet ?? params.fluteWidthDesktop;
  else v = params.fluteWidthDesktop;
  const unit = (params.fluteWidthUnit || 'vw').toLowerCase();
  if (unit === 'px') return Math.max(1, Number(v) || 1);
  // vw or % act the same here: percentage of canvas width
  let flutePx = Math.max(1, w * (Number(v) || 0) / 100);
  
  // Apply reasonable bounds to maintain proportional appearance:
  // Min: 10px (ensures reeds are clearly visible even on small screens)
  // Max: 22px (prevents reeds from becoming too chunky on large screens)
  flutePx = Math.max(10, Math.min(22, flutePx));
  
  return flutePx;
}

// Scale-dependent values relative to a baseline flute width; tweak baseline to taste
const BASELINE_FLUTE_WIDTH_PX = 12.0;
function scaleFromWidth(valAtBaseline, fluteWidthPx){
  const scale = Math.max(fluteWidthPx, 1) / BASELINE_FLUTE_WIDTH_PX;
  return valAtBaseline * scale;
}

const reededFrag = /* glsl */ `
uniform vec2 resolution;         // canvas size in px
uniform float uRotation;         // degrees
uniform float uBandTiltDeg;      // degrees
uniform float uFluteWidthPx;     // width of a single flute in pixels
uniform float uRefractPx;        // max per-strip sampling offset (px) at edges
uniform float uCurve;            // profile shaping exponent (>=1)
uniform float uEdgeFeatherPx;    // feather width in pixels
uniform float gradientWhiteStrength;  // 0..1 strength of white side highlight
uniform float gradientBlackStrength;  // 0..1 strength of black side darkening
// Scene depth input (RGBADepthPacking) + camera planes
uniform sampler2D tDepth;
uniform float cameraNear;
uniform float cameraFar;
uniform float depthD0;  // near distance for no effect
uniform float depthD1;  // far distance for full effect
uniform float depthMaskDebug;      // >0.5 to output mask
// Screen-space gradient controls with stops
uniform float gradientStop1Distance;   // distance from center (0-0.5)
uniform float gradientStop2Distance;   // distance from center (0-0.5)
uniform float refractPxStop1;
uniform float refractPxStop2;
uniform float gradientWhiteStop1;
uniform float gradientWhiteStop2;
uniform float gradientBlackStop1;
uniform float gradientBlackStop2;
// Flute width variation
uniform float fluteWidthCenterScale;   // multiplier at center
uniform float fluteWidthEdgeScale;     // multiplier at edges
// Frost/blur effect
uniform float frostStop1;             // frost intensity at stop1
uniform float frostStop2;             // frost intensity at stop2
// Scroll-based controls
uniform float scrollProgress;          // 0-1 scroll progress to override gradient/depth masking
uniform float scrollRefractionMultiplier; // multiplier for refraction during scroll
// Split-screen controls
uniform float splitScreenMode;         // >0.5 to enable split-screen left/right effect
uniform float splitScreenBoundary;    // X position (0-1) where effect boundary occurs
uniform float rightSideProgress;      // 0-1 progress for right side effect (for smooth transition)

// --- Depth helpers (match three.js packing chunk) ---
float orthographicDepthToViewZ( const in float linearClipZ, const in float near, const in float far ) {
  return linearClipZ * ( near - far ) - near;
}

float unpackRGBAToDepth( const in vec4 v ) {
  const vec4 bitShift = vec4( 1.0/(256.0*256.0*256.0), 1.0/(256.0*256.0), 1.0/256.0, 1.0 );
  return dot( v, bitShift );
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float canvasAspect = resolution.x / max(resolution.y, 1.0);
  
  // Compute distance from center for width variation
  float center = 0.5;
  float distFromCenter = abs(uv.x - center);
  float widthScale = mix(fluteWidthCenterScale, fluteWidthEdgeScale, distFromCenter * 2.0);
  
  float baseFluteWidthPx = max(uFluteWidthPx, 1.0);
  float fluteWidthPx = baseFluteWidthPx * widthScale;
  float rotationRadians = radians(uRotation);
  float bandTiltRadians = radians(uBandTiltDeg);

  // Adjust the UV for source aspect so content doesn’t squash when rotated
  vec2 scaledUV = uv; // assume source aspect equals canvas

  // Rotate UVs so fluting runs along the X axis in rotated space
  float c = cos(rotationRadians), s = sin(rotationRadians);
  vec2 centered = scaledUV - 0.5;
  vec2 rotatedUV = vec2(
    c * centered.x - s * centered.y,
    s * centered.x + c * centered.y
  ) + 0.5;

  // Additional small tilt only used to compute banding/prismatic feel
  float cb = cos(rotationRadians + bandTiltRadians), sb = sin(rotationRadians + bandTiltRadians);
  vec2 rotatedBandUV = vec2(
    cb * centered.x - sb * centered.y,
    sb * centered.x + cb * centered.y
  ) + 0.5;

  // Determine number of slices using true pixel length along rotated-X axis
  float rotatedAxisPixelsPerUV = length(vec2(c * resolution.x, s * resolution.y));
  float numSlices = max(floor(rotatedAxisPixelsPerUV / fluteWidthPx), 1.0);

  // Banded profiles per strip in screen space (sharp edges)
  float scaled = rotatedBandUV.x * numSlices + 0.25; // fixed phase offset
  float stripIndex = floor(scaled);
  float sliceProgress = fract(scaled); // 0..1 across current strip
  float tau = sliceProgress * 2.0 - 1.0; // -1..+1, center=0
  
  // Compute curve shaping (cylindrical profile)
  float y01 = clamp(rotatedUV.y, 0.0, 1.0);
  float curveEff = uCurve;

  // Screen-space horizontal gradient with stops from center
  // Reuse distFromCenter calculated above for width variation
  
  // 2-stop gradient: 0-10%, 10-30%, 30-50%
  float gradientT;
  if (distFromCenter <= gradientStop1Distance) {
    // 0% to stop1: no effect
    gradientT = 0.0;
  } else if (distFromCenter <= gradientStop2Distance) {
    // stop1 to stop2: linear interpolation from 0 to 1
    gradientT = (distFromCenter - gradientStop1Distance) / max(gradientStop2Distance - gradientStop1Distance, 0.001);
  } else {
    // stop2 to edge: full effect
    gradientT = 1.0;
  }

  // Depth-based mask: 0 near (no effect) -> 1 far (full effect)
  float packed = unpackRGBAToDepth( texture2D(tDepth, uv) );
  float viewZ  = orthographicDepthToViewZ(packed, cameraNear, cameraFar);
  float depthMeters = -viewZ;                 // positive distances forward for ortho
  
  // Depth gate: 0 below D0, 1 above D1, smooth in between
  float depthMask = smoothstep(depthD0, depthD1, depthMeters);

  // Debug visualization of the mask (grayscale)
  if (depthMaskDebug > 0.5) {
    outputColor = vec4(vec3(depthMask), inputColor.a);
    return;
  }

  // Final intensity = screen-gradient gated by depth, or smoothly blended with scroll
  float effectT;
  if (scrollProgress > 0.001) {
    // Smoothly blend between original effect and full coverage based on scroll
    float baseEffectT = clamp(gradientT * depthMask, 0.0, 1.0);
    // Use smooth interpolation with easing curve
    float smoothScroll = smoothstep(0.0, 1.0, scrollProgress);
    effectT = mix(baseEffectT, 1.0, smoothScroll);
    
    // Apply split-screen effect if enabled
    if (splitScreenMode > 0.5) {
      // Create split-screen mask: 0 on left, 1 on right
      float splitMask = step(splitScreenBoundary, uv.x);
      
      // Left side: use full effectT
      // Right side: interpolate between baseEffectT and effectT based on rightSideProgress
      float rightSideEffectT = mix(baseEffectT, effectT, rightSideProgress);
      
      // Apply the split: left gets effectT, right gets rightSideEffectT
      effectT = mix(effectT, rightSideEffectT, splitMask);
    }
  } else {
    // Original behavior: screen-gradient gated by depth
    effectT = clamp(gradientT * depthMask, 0.0, 1.0);
  }
  
  // Interpolate baseline parameters based on final effect intensity
  float refractPxFinal = mix(refractPxStop1, refractPxStop2, effectT);
  
  // Increase refraction during scroll with configurable multiplier
  if (scrollProgress > 0.001) {
    float refractionBoost = 1.0 + ((scrollRefractionMultiplier - 1.0) * scrollProgress);
    refractPxFinal *= refractionBoost;
  }
  
  // Add extra refraction boost for depths beyond depthD1 (far surfaces)
  float depthBoost = 1.0;
  if (depthMeters > depthD1) {
    // Progressive boost beyond depthD1: 1x at depthD1, up to 2.5x at far distances
    float extraDepth = depthMeters - depthD1;
    depthBoost = 1.0 + clamp(extraDepth * 0.1, 0.0, 1.5); // Scale factor for boost intensity
  }
  refractPxFinal *= depthBoost;
  
  float gWFinal = mix(gradientWhiteStop1, gradientWhiteStop2, effectT);
  float gBFinal = mix(gradientBlackStop1, gradientBlackStop2, effectT);
  float frostIntensity = mix(frostStop1, frostStop2, effectT);
  
  // Gradually increase frosting when scrolling with smooth curve
  if (scrollProgress > 0.001) {
    float frostMultiplier = 1.0 + (scrollProgress * scrollProgress * 1.5); // Quadratic easing
    frostIntensity *= frostMultiplier;
  }
  // Slight additional frost beyond depthD1 to haze the distant sphere
  if (depthMeters > depthD1) {
    float frostBoost = clamp((depthMeters - depthD1) * 0.05, 0.0, 2.0);
    frostIntensity *= (1.0 + frostBoost * 0.3);
  }

  // Y-envelope for spiked silhouette (bell-like: strong mid, weaker top/bottom)
  float env = abs(sin(3.14159265 * (y01 - 0.5)));
  // Modulate refraction by Y envelope: ~60% at top/bottom, 100% at center
  float refractPxEff = refractPxFinal * mix(0.6, 1.0, env);

  // Cylindrical lens slope per strip
  // tau in [-1,1] across the band
  float u = clamp(tau, -0.999, 0.999);

  // cylinder slope: nx = u / sqrt(1 - u^2)
  float nx = u / max(sqrt(1.0 - u*u), 1e-4);

  // shaping (gamma-style)
  float nxShaped = sign(nx) * pow(abs(nx), max(curveEff, 1.0));

  // Compute base (non-offset) UV for blending/edge fades
  vec2 finalUVBase = vec2(
    c * centered.x + s * centered.y,
   -s * centered.x + c * centered.y
  ) + 0.5;

  // Edge fade: attenuate refraction near the texture borders to avoid artifacts
  vec2 px = vec2(1.0 / max(resolution.x, 1.0), 1.0 / max(resolution.y, 1.0));
  float minDx = min(finalUVBase.x, 1.0 - finalUVBase.x);
  float minDy = min(finalUVBase.y, 1.0 - finalUVBase.y);
  float minDBorder = min(minDx, minDy);
  float edgeMargin = max(4.0 * px.x, 4.0 * px.y); // ~4px margin
  float edgeFade = smoothstep(0.0, edgeMargin, minDBorder);

  // Pixel-correct refraction offset projected to UV per axis
  float offPx = (refractPxEff * nxShaped) * edgeFade; // pixels along rotated-X
  vec2 deltaUV = vec2(
    (offPx * c) / max(resolution.x, 1.0),
    (-offPx * s) / max(resolution.y, 1.0)
  );

  // band width in px (flute width)
  float bandWidthPx = fluteWidthPx;

  // DO NOT clamp refractPxEff to bandWidthPx*0.5 — allow 0.6–1.2× for duplication
  // Suggested ranges:
  // uSegments: 60–110
  // uRefractPx: 6–14 (can go up to ~bandWidthPx)
  // uCurve: 1.3–2.0
  // uEdgeFeatherPx: 1–3
  // uBandTiltDeg: 2–6

  // edge feather (in pixels → fractional)
  float bandPx = fluteWidthPx;
  float f = clamp(uEdgeFeatherPx / bandPx, 0.0, 0.49);

  // feather: ~1 in band interior, ~0 at edges
  float feather = smoothstep(0.0, f, sliceProgress) *
                  (1.0 - smoothstep(1.0 - f, 1.0, sliceProgress));

  // Final refracted UV using pixel-consistent offset
  vec2 finalUV = finalUVBase + deltaUV;

  // finalUVBase was computed earlier (non-offset UV for blending)

  // Border-safe clamped UVs with a small epsilon to avoid sampling exactly at 0/1
  vec2 eps = vec2(1.0 / max(resolution.x, 1.0), 1.0 / max(resolution.y, 1.0));
  vec2 refrUV = clamp(finalUV, eps, 1.0 - eps);
  vec2 baseUV = clamp(finalUVBase, eps, 1.0 - eps);

  // Chromatic aberration mapped to effectT (in pixels along rotated-X)
  float chromaPx = mix(1.0, 3.0, effectT);
  vec2 chromaDeltaUV = vec2(
    (chromaPx * c) / max(resolution.x, 1.0),
    (-chromaPx * s) / max(resolution.y, 1.0)
  );

  // Per-channel sampling with pixel-consistent chromatic shift
  vec3 refrRGB;
  vec2 refrUVR = clamp(refrUV + chromaDeltaUV, eps, 1.0 - eps);
  vec2 refrUVB = clamp(refrUV - chromaDeltaUV, eps, 1.0 - eps);
  refrRGB.r = texture2D(inputBuffer, refrUVR).r;
  refrRGB.g = texture2D(inputBuffer, refrUV ).g;
  refrRGB.b = texture2D(inputBuffer, refrUVB).b;

  // Add frost/blur effect if intensity > 0 (isotropic in pixels across X/Y)
  if (frostIntensity > 0.01) {
    // Convert a pixel radius into UV units per-axis so blur strength stays consistent
    vec2 frostRadiusUV = vec2(
      frostIntensity / max(resolution.x, 1.0),
      frostIntensity / max(resolution.y, 1.0)
    );
    // 4-tap blur pattern for performance
    vec2 offsets[4];
    offsets[0] = vec2( frostRadiusUV.x, 0.0);
    offsets[1] = vec2(-frostRadiusUV.x, 0.0);
    offsets[2] = vec2(0.0,  frostRadiusUV.y);
    offsets[3] = vec2(0.0, -frostRadiusUV.y);
    
    vec3 frostSample = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 sampleUV = clamp(refrUV + offsets[i], eps, 1.0 - eps);
      frostSample += texture2D(inputBuffer, sampleUV).rgb;
    }
    frostSample *= 0.25; // average of 4 samples
    
    // Blend frost effect based on intensity
    float frostBlend = clamp(frostIntensity * 0.3, 0.0, 0.8);
    refrRGB = mix(refrRGB, frostSample, frostBlend);
  }

  vec3 baseRGB = texture2D(inputBuffer, baseUV).rgb;
  
  // full band refracts; edges fade to base
  float w = feather;
  vec3 mixRGB = mix(baseRGB, refrRGB, w);
  // Cylindrical white->black gradient across tau (flipped)
  float shade = smoothstep(-1.0, 1.0, -tau); // flip horizontally
  float gW = clamp(gWFinal, 0.0, 1.0);
  float gB = clamp(gBFinal, 0.0, 1.0);
  // Sharpen near the white side as gW increases
  shade = pow(shade, mix(1.0, 1.25, gW));
  vec3  gradient = mix(vec3(1.0), vec3(0.0), shade);
  // Apply only black-side darkening via gB, respect screen-space gradient mask
  vec3  lit = mix(vec3(1.0), gradient, clamp(gB * gradientT * 1.0, 0.0, 1.0));

  // Add a subtle white-edge highlight so lines remain visible on dark backgrounds
  // Make white lines respect the screen-space gradient mask (fade towards center)
  float whiteEdge = smoothstep(0.935, 1.0, shade); // slightly wider and earlier
  
  // Add noise to white lines for more realistic variation along vertical length
  vec2 noiseCoord = vec2(stripIndex * 0.1, uv.y * 3.0 + stripIndex * 0.3);
  float noise1 = fract(sin(dot(noiseCoord, vec2(12.9898, 78.233))) * 43758.5453);
  float noise2 = fract(sin(dot(noiseCoord * 1.0, vec2(39.346, 11.135))) * 23421.631);
  float combinedNoise = mix(noise1, noise2, 1.0);
  
  // Modulate white line intensity with noise (0.4 to 1.8 range for more apparent variation)
  float noiseVariation = mix(0.3, 1.4, combinedNoise);
  vec3  addHL = vec3(1.0) * (whiteEdge * 0.15 * gW * w * gradientT * noiseVariation);

  vec3 finalRGB = mixRGB * lit + addHL;
  outputColor = vec4(finalRGB, inputColor.a);  // Preserve input alpha
}
`;

export function createReededPass(camera){
  const effect = new Effect('FlutedGlassEffect', reededFrag, {
    uniforms: new Map([
      ['resolution',      new THREE.Uniform(new THREE.Vector2(1,1))],
      ['uRotation',       new THREE.Uniform(reededParams.rotationDeg)],
  ['uBandTiltDeg',    new THREE.Uniform(reededParams.bandTiltDeg)],
  ['uFluteWidthPx',   new THREE.Uniform(12.0)],
  ['uRefractPx',      new THREE.Uniform(reededParams.refractPx)],
  ['uCurve',          new THREE.Uniform(reededParams.curve)],
  ['uEdgeFeatherPx',  new THREE.Uniform(reededParams.edgeFeatherPx)],
  ['gradientWhiteStrength', new THREE.Uniform(reededParams.gradientWhiteStrength)],
  ['gradientBlackStrength', new THREE.Uniform(reededParams.gradientBlackStrength)],
  ['gradientStop1Distance', new THREE.Uniform(reededParams.gradientStop1Distance)],
  ['gradientStop2Distance', new THREE.Uniform(reededParams.gradientStop2Distance)],
  ['refractPxStop1', new THREE.Uniform(reededParams.refractPxStop1)],
  ['refractPxStop2', new THREE.Uniform(reededParams.refractPxStop2)],
  ['gradientWhiteStop1', new THREE.Uniform(reededParams.gradientWhiteStop1)],
  ['gradientWhiteStop2', new THREE.Uniform(reededParams.gradientWhiteStop2)],
  ['gradientBlackStop1', new THREE.Uniform(reededParams.gradientBlackStop1)],
  ['gradientBlackStop2', new THREE.Uniform(reededParams.gradientBlackStop2)],
  ['fluteWidthCenterScale', new THREE.Uniform(reededParams.fluteWidthCenterScale)],
  ['fluteWidthEdgeScale', new THREE.Uniform(reededParams.fluteWidthEdgeScale)],
  ['frostStop1', new THREE.Uniform(reededParams.frostStop1)],
  ['frostStop2', new THREE.Uniform(reededParams.frostStop2)],
  ['scrollProgress', new THREE.Uniform(0.0)],
  ['scrollRefractionMultiplier', new THREE.Uniform(3.0)], // Default 3x multiplier
  ['splitScreenMode', new THREE.Uniform(reededParams.splitScreenMode ? 1.0 : 0.0)],
  ['splitScreenBoundary', new THREE.Uniform(reededParams.splitScreenBoundary)],
  ['rightSideProgress', new THREE.Uniform(0.0)],
  // Depth uniforms (wired from main each frame)
  ['tDepth', new THREE.Uniform(null)],
  ['cameraNear', new THREE.Uniform(0.1)],
  ['cameraFar', new THREE.Uniform(1000.0)],
  ['depthD0', new THREE.Uniform(reededParams.depthD0)],
  ['depthD1', new THREE.Uniform(reededParams.depthD1)],
  ['depthMaskDebug', new THREE.Uniform(reededParams.depthMaskDebug ? 1.0 : 0.0)],
  // curve-Y uniforms removed
    ])
  });
  const pass = new EffectPass(camera, effect);
  return { effect, pass };
}

export function setReededResolution(effect, w, h){
  if (!effect) return;
  const u = effect.uniforms.get('resolution');
  if (u) u.value.set(w, h);
  const fw = effect.uniforms.get('uFluteWidthPx');
  if (fw) fw.value = computeFluteWidthPx(reededParams, w);
}

export function tickReededTime(effect, dt){
  if (!effect) return;
}

export function updateReeded(effect, pass, partial){
  Object.assign(reededParams, partial || {});
  if (effect) {
    const U = effect.uniforms;
  U.get('uRotation').value = reededParams.rotationDeg;
  U.get('uBandTiltDeg').value = reededParams.bandTiltDeg;
  const res = effect.uniforms.get('resolution')?.value;
  const canvasW = res ? res.x : 0;
  U.get('uFluteWidthPx').value = computeFluteWidthPx(reededParams, canvasW);
  U.get('uRefractPx').value = reededParams.refractPx;
  U.get('uCurve').value = reededParams.curve;
  U.get('uEdgeFeatherPx').value = reededParams.edgeFeatherPx;
  U.get('gradientWhiteStrength').value = reededParams.gradientWhiteStrength;
  U.get('gradientBlackStrength').value = reededParams.gradientBlackStrength;
  U.get('gradientStop1Distance').value = reededParams.gradientStop1Distance;
  U.get('gradientStop2Distance').value = reededParams.gradientStop2Distance;
  U.get('refractPxStop1').value = reededParams.refractPxStop1;
  U.get('refractPxStop2').value = reededParams.refractPxStop2;
  U.get('gradientWhiteStop1').value = reededParams.gradientWhiteStop1;
  U.get('gradientWhiteStop2').value = reededParams.gradientWhiteStop2;
  U.get('gradientBlackStop1').value = reededParams.gradientBlackStop1;
  U.get('gradientBlackStop2').value = reededParams.gradientBlackStop2;
  U.get('frostStop1').value = reededParams.frostStop1;
  U.get('frostStop2').value = reededParams.frostStop2;
  U.get('splitScreenMode').value = reededParams.splitScreenMode ? 1.0 : 0.0;
  U.get('splitScreenBoundary').value = reededParams.splitScreenBoundary;
  // Depth params (texture set from main each frame via setReededDepth())
  U.get('cameraNear').value = U.get('cameraNear').value || 0.1; // keep as-is until set
  U.get('cameraFar').value = U.get('cameraFar').value || 1000.0;
  U.get('depthD0').value = reededParams.depthD0;
  U.get('depthD1').value = reededParams.depthD1;
  U.get('depthMaskDebug').value = reededParams.depthMaskDebug ? 1.0 : 0.0;
  }
  if (pass) pass.enabled = !!reededParams.enabled;
}

// Helper to update depth texture and camera planes per frame
export function setReededDepth(effect, depthTexture, near, far){
  if (!effect) return;
  const U = effect.uniforms;
  if (U.has('tDepth')) {
    U.get('tDepth').value = depthTexture || null;
  }
  if (U.has('cameraNear')) U.get('cameraNear').value = near;
  if (U.has('cameraFar')) U.get('cameraFar').value = far;
}

// Helper to update scroll-based effect coverage
export function setReededScrollProgress(effect, scrollProgress){
  if (!effect) return;
  const U = effect.uniforms;
  if (U.has('scrollProgress')) {
    U.get('scrollProgress').value = Math.max(0, Math.min(1, scrollProgress || 0));
  }
}

// Helper to configure scroll refraction multiplier
export function setReededScrollRefractionMultiplier(effect, multiplier){
  if (!effect) return;
  const U = effect.uniforms;
  if (U.has('scrollRefractionMultiplier')) {
    U.get('scrollRefractionMultiplier').value = Math.max(1, multiplier || 3.0);
  }
}

// Helper to control split-screen mode
export function setReededSplitScreenMode(effect, enabled, boundary = 0.5, rightSideProgress = 0.0){
  if (!effect) return;
  const U = effect.uniforms;
  if (U.has('splitScreenMode')) {
    U.get('splitScreenMode').value = enabled ? 1.0 : 0.0;
  }
  if (U.has('splitScreenBoundary')) {
    U.get('splitScreenBoundary').value = Math.max(0, Math.min(1, boundary));
  }
  if (U.has('rightSideProgress')) {
    U.get('rightSideProgress').value = Math.max(0, Math.min(1, rightSideProgress));
  }
}

// ---------------- Procedural Grain (overlay) ----------------
export const grainParams = {
  opacity: 0.08
};

const grainFrag = /* glsl */ `
uniform float opacity;
float random(vec2 uv) {
  return fract(sin(dot(uv.xy ,vec2(12.9898,78.233))) * 43758.5453);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float g = random(uv);
  vec3 gv = vec3(g);
  vec3 mask = step(gv, vec3(0.5));
  vec3 overlay = mix(
    2.0 * inputColor.rgb * gv,
    1.0 - 2.0 * (1.0 - inputColor.rgb) * (1.0 - gv),
    1.0 - mask
  );
  vec3 color = mix(inputColor.rgb, overlay, opacity);
  outputColor = vec4(color, inputColor.a);
}
`;

export function createGrainPass(camera){
  const effect = new Effect('ProceduralGrainEffect', grainFrag, {
    uniforms: new Map([
      ['opacity', new THREE.Uniform(grainParams.opacity)]
    ])
  });
  const pass = new EffectPass(camera, effect);
  return { effect, pass };
}

export function updateGrain(effect, partial){
  Object.assign(grainParams, partial || {});
  if (effect) effect.uniforms.get('opacity').value = grainParams.opacity;
}

// ---------------- Bottom Vignette (screen-space fade at bottom edge) ----------------
export const bottomVignetteParams = {
  heightPct: 0.15,   // bottom 15% of the screen
  power: 1.0         // shaping exponent; >1 sharpens near bottom
};

const bottomVignetteFrag = /* glsl */ `
uniform vec2 resolution;      // canvas size in px
uniform float heightPct;      // fraction of screen height (0..1)
uniform float power;          // shaping exponent (>=1)

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Compute bottom fade mask using framebuffer Y in pixels
  float heightPx = max(1.0, resolution.y * clamp(heightPct, 0.0, 1.0));
  float mask = smoothstep(0.0, heightPx, gl_FragCoord.y);
  // Optional shaping
  mask = pow(mask, max(power, 1.0));
  vec3 col = inputColor.rgb * mask;
  outputColor = vec4(col, inputColor.a);
}
`;

export function createBottomVignettePass(camera){
  const effect = new Effect('BottomVignette', bottomVignetteFrag, {
    uniforms: new Map([
      ['resolution', new THREE.Uniform(new THREE.Vector2(1,1))],
      ['heightPct',  new THREE.Uniform(bottomVignetteParams.heightPct)],
      ['power',      new THREE.Uniform(bottomVignetteParams.power)]
    ])
  });
  const pass = new EffectPass(camera, effect);
  return { effect, pass };
}

export function setBottomVignetteResolution(effect, w, h){
  if (!effect) return;
  const u = effect.uniforms.get('resolution');
  if (u) u.value.set(w, h);
}

export function updateBottomVignette(effect, partial){
  Object.assign(bottomVignetteParams, partial || {});
  if (!effect) return;
  const U = effect.uniforms;
  U.get('heightPct').value = bottomVignetteParams.heightPct;
  U.get('power').value     = bottomVignetteParams.power;
}
