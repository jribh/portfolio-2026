import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

import { EffectComposer, RenderPass, EffectPass, SelectiveBloomEffect, SMAAEffect, SMAAPreset, HueSaturationEffect, BrightnessContrastEffect , Effect } from 'postprocessing';
import { reededParams, createReededPass, setReededResolution, tickReededTime, updateReeded as _updateReeded, createGrainPass, updateGrain, setReededDepth, setReededScrollProgress, setReededScrollRefractionMultiplier, setReededSplitScreenMode, createBottomVignettePass, setBottomVignetteResolution, updateBottomVignette } from './effects/OverlayEffects.js';
import { gsap } from 'gsap';

import hdriUrl from './assets/hdri_bg.hdr';
import modelUrl from './assets/head_packed.glb';
import shadowMaskUrl from './assets/Head_Shadowmask.png';

let headContainer = document.querySelector("#head-container");
headContainer.style.overflow = "default";
let currentTime;

// Startup sequence state
let startupActive = true;
let allowHeadLook = false;
let allowBreathing = false; // both chin & shoulder breathing enabled together after startup
const eyeMeshes = [];
const initialChinLiftRad = -0.25; // slight look up during startup

// Touch-device detection (phones/tablets)
const IS_TOUCH_DEVICE = (function(){
  try {
    if (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) return true;
    if ('ontouchstart' in window) return true;
    const ua = (navigator.userAgent || '').toLowerCase();
    return /mobi|iphone|ipad|android|tablet/.test(ua);
  } catch { return false; }
})();

const inactivityThreshold = 5000; // time before head moves back to position

const WIND_BASE_TS = 1.0;

let scene = new THREE.Scene();
let w = window.innerWidth;
let h = window.innerHeight;
let aspectRatio = w/h,
    fieldOfView = 30,
    nearPlane = 1,
    farPlane = 400;

let frustumSize = 32; // reduce this to increase zoom
let frustumHeight = 1; // increase this to bring lower

let camera = new THREE.OrthographicCamera(
    frustumSize*aspectRatio/-2, frustumSize*aspectRatio/2, frustumSize+frustumHeight, frustumHeight, nearPlane, farPlane
)

camera.position.set( 0, 0, 200);
// Startup: begin slightly zoomed-in (orthographic zoom > 1 zooms in)
const STARTUP_CAM_ZOOM = 1.06; // subtle close look
camera.zoom = STARTUP_CAM_ZOOM;
camera.updateProjectionMatrix();

const theCanvas = document.querySelector("#artboard");
const bgEl = document.getElementById('head-background');
const g2xEl = document.getElementById('g2x'); // optional red radial gradient overlay
// Ensure initial blackout
if (theCanvas) theCanvas.style.opacity = '0';
if (bgEl) bgEl.style.opacity = '0';
// Create a fullscreen blackout overlay that fades out on startup
let blackoutEl = document.createElement('div');
blackoutEl.style.position = 'fixed';
blackoutEl.style.inset = '0';
blackoutEl.style.background = '#000';
blackoutEl.style.zIndex = '9999';
blackoutEl.style.opacity = '1';
blackoutEl.style.pointerEvents = 'none';
document.body.appendChild(blackoutEl);

theCanvas.style.overflow = "hidden";
theCanvas.style.left = '0';
theCanvas.style.position = 'fixed';

let renderer = new THREE.WebGLRenderer({
    canvas : theCanvas,
    alpha : true,
    antialias : true
//  preserveDrawingBuffer: true 
})

THREE.Cache.clear();

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setClearColor( 0x000000, 0 ); // the default
renderer.shadowMap.enabled = true;
renderer.physicallyCorrectLights = true;
// Start dark
renderer.toneMappingExposure = 0.0;
// Prefer maximum available anisotropy for crisper textures
const MAX_ANISOTROPY = (renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function')
  ? renderer.capabilities.getMaxAnisotropy()
  : 1;

// // This is for the bloom post processing
const renderScene = new RenderPass(scene, camera)
const composer = new EffectComposer(renderer)

const bloomEffect = new SelectiveBloomEffect( scene, camera, {
  intensity: 2.2,
  radius: 0.8,                 // wider spread
  luminanceThreshold: 0.02,    // bloom earlier
  luminanceSmoothing: 0.03
});

// Reeded Glass (external module): create pass + expose a window updater for convenience
let _reedEffect = null;
let _reedPass = null;
window.reededParams = reededParams; // expose for quick console tweaks
window.updateReeded = (partial)=> _updateReeded(_reedEffect, _reedPass, partial);

// Bottom vignette (screen fade at bottom), applied before reeded glass so glass overlay is unaffected
let _vignetteEffect = null;
let _vignettePass = null;

// ----------------------------------
// Fullscreen gradient background plane
// ----------------------------------
let _bgGrad = null;
// Black bottom cover plane for portrait phones
let _bottomCover = null;

function ensureBottomCover(){
  if (_bottomCover) return _bottomCover;
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  // Shader with feathered top edge (fade alpha near top)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor:    { value: new THREE.Color(0x000000) },
      uOpacity:  { value: 1.0 },
      uFeather:  { value: 0.3 } // fraction of height to feather at top (increased blur)
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uFeather;
      void main(){
        // Fade out only near the top edge: fully opaque below, smooth to 0 at top
        float a = 1.0 - smoothstep(1.0 - uFeather, 1.0, vUv.y);
        gl_FragColor = vec4(uColor, a * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'BottomCoverPlane';
  // Draw last and above everything to hide seam
  mesh.renderOrder = 999;
  mesh.position.z = 100; // well in front of scene content
  mesh.visible = false;  // enabled only when needed
  scene.add(mesh);
  _bottomCover = mesh;
  return mesh;
}

// Optional: allow runtime tuning of feather width (0..0.6 recommended)
window.setBottomCoverFeather = function(v){
  const m = ensureBottomCover();
  if (m && m.material && m.material.uniforms && m.material.uniforms.uFeather){
    m.material.uniforms.uFeather.value = Math.max(0.0, Math.min(0.6, Number(v) || 0));
  }
};

function updateBottomCoverPlane(coverHeight){
  const m = ensureBottomCover();
  if (!coverHeight || coverHeight <= 0){ m.visible = false; return; }
  // Fit to current camera frustum width and requested cover height, align to bottom
  const fw = (camera.right - camera.left);
  const fh = (camera.top - camera.bottom);
  m.visible = true;
  m.scale.set(fw, coverHeight, 1);
  m.position.x = (camera.left + camera.right) * 0.5;
  m.position.y = camera.bottom + coverHeight * 0.5;
}

function createGradientBackground() {
  if (_bgGrad) return;
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
  uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uTopColor: { value: new THREE.Color(0x1C214B) },
  uBottomColor: { value: new THREE.Color(0x0A0707) },
  // Radial red glow (#77211A), centered horizontally, 25% from bottom
  uGlowColor: { value: new THREE.Color(0x77211A) },
  uGlowCenter: { value: new THREE.Vector2(0.5, 0.25) },
  uGlowRadius: { value: 0.43 },
  uGlowIntensity: { value: 0.9 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 uTopColor;
      uniform vec3 uBottomColor;
      uniform vec2 uResolution;
      uniform vec3 uGlowColor; 
      uniform vec2 uGlowCenter; 
      uniform float uGlowRadius; 
      uniform float uGlowIntensity;

      vec3 screenBlend(vec3 base, vec3 over){
        return 1.0 - (1.0 - base) * (1.0 - over);
      }
      void main() {
        // vUv.y is 1.0 at top and 0.0 at bottom for PlaneGeometry
        float t = 1.0 - clamp(vUv.y, 0.0, 1.0);
        vec3 col = mix(uTopColor, uBottomColor, t);

        // Circular blur gradient (aspect-correct) as a red glow behind the head
        vec2 p = vUv - uGlowCenter;
        float aspect = max(uResolution.x, 1.0) / max(uResolution.y, 1.0);
        p.x *= aspect;
        float d = length(p);
        float m = 1.0 - smoothstep(0.0, max(uGlowRadius, 1e-4), d); // 1 at center -> 0 at radius
        // Slight softening
        m = pow(m, 1.4);
        vec3 glow = uGlowColor * (uGlowIntensity * m);
        col = screenBlend(col, glow);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthTest: true,
    depthWrite: true,
    toneMapped: false
  });
  _bgGrad = new THREE.Mesh(geo, mat);
  _bgGrad.name = 'BackgroundGradientPlane';
  _bgGrad.renderOrder = -1000; // draw first
  _bgGrad.position.z = -80;    // behind everything else
  scene.add(_bgGrad);
}

function positionGradientBackgroundFromFrustum() {
  if (!_bgGrad) return;
  const w = (camera.right - camera.left);
  const h = (camera.top - camera.bottom);
  _bgGrad.scale.set(w, h, 1);
  _bgGrad.position.x = (camera.left + camera.right) * 0.5;
  _bgGrad.position.y = (camera.top + camera.bottom) * 0.5;

  // Keep shader aware of CSS pixel resolution for consistent look
  const vw = window.visualViewport ? Math.floor(window.visualViewport.width) : window.innerWidth;
  const vh = window.visualViewport ? Math.floor(window.visualViewport.height) : window.innerHeight;
  const uRes = _bgGrad.material.uniforms.uResolution;
  if (uRes && uRes.value) uRes.value.set(vw, vh);
}

// Update gradient colors based on scroll progress
function updateGradientColorsForScroll(scrollProgress) {
  if (!_bgGrad || !_bgGrad.material || !_bgGrad.material.uniforms) return;
  
  // Original top color: #1C214B (dark blue)
  // Target top color when scrolled: #050505 (almost black)
  const originalTopColor = new THREE.Color(0x1C214B);
  const scrolledTopColor = new THREE.Color(0x0C0F21);
  
  // Interpolate between original and scrolled top color
  const currentTopColor = originalTopColor.clone().lerp(scrolledTopColor, scrollProgress);
  
  // Update the uniform
  _bgGrad.material.uniforms.uTopColor.value.copy(currentTopColor);
}

// ----------------------------------
// Large blurred glow blobs (additive quads behind head)
// ----------------------------------
let _glowBlobs = [];
let _glowInited = false;

function _createGlowMaterial(tint, intensity = 1.0, radius = 0.55, softness = 0.35) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTint:      { value: new THREE.Color(tint) },
      uIntensity: { value: intensity },
      uRadius:    { value: radius },
      uSoftness:  { value: softness }
    },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 uTint;
      uniform float uIntensity;
      uniform float uRadius;
      uniform float uSoftness;
      void main(){
        vec2 p = vUv - 0.5;
        float dist = length(p);
        float e0 = max(uRadius - uSoftness, 0.0);
        float e1 = uRadius;
        float glow = 1.0 - smoothstep(e0, e1, dist);
        vec3 col = uTint * glow * uIntensity;
        gl_FragColor = vec4(col, glow);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: true
  });
}

function _createGlowBlob({ name, color, wFrac, hFrac, anchor, offFracX, offFracY, z = -40, intensity = 0.9, radius = 0.6, softness = 0.4, anim = {} }){
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  const mat = _createGlowMaterial(color, intensity, radius, softness);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name || 'GlowBlob';
  mesh.renderOrder = -500; // draw early, stays behind via depth
  mesh.position.z = z;
  // metadata for updates
  mesh.userData.glow = {
    wFrac, hFrac,
    anchor, offFracX, offFracY,
    baseIntensity: intensity,
    baseColor: new THREE.Color(color),
    anim: Object.assign({
      speed: 0.15,
      ampScale: 0.06,
      ampIntensity: 0.2,
      phase: 0
    }, anim)
  };
  scene.add(mesh);
  _glowBlobs.push(mesh);
  return mesh;
}

function _getFrustumSize(){
  return {
    w: (camera.right - camera.left),
    h: (camera.top - camera.bottom)
  };
}

function _anchorWorld(anchor){
  const v = new THREE.Vector3();
  if (!anchor) return v.set(0,0,0);
  try { anchor.getWorldPosition(v); return v; } catch{ return v.set(0,0,0); }
}

function _updateGlowBlobs(time){
  if (!_glowBlobs.length) return;
  const { w: fw, h: fh } = _getFrustumSize();
  for (const m of _glowBlobs){
    const g = m.userData.glow;
    // scale vs frustum
    const sX = g.wFrac * fw;
    const sY = g.hFrac * fh;
    // subtle scale animation
    const an = g.anim;
    const osc = Math.sin(time * an.speed + (an.phase || 0));
    const scaleMod = 1.0 + osc * an.ampScale;
    m.scale.set(sX * scaleMod, sY * scaleMod, 1);
    // intensity animation using base intensity
    const mat = m.material;
    const baseI = g.baseIntensity;
    const iMod = 1.0 + osc * an.ampIntensity;
    mat.uniforms.uIntensity.value = baseI * iMod;
    
    // position using anchor bone + fractional offset of frustum + slow movement animation
    const a = _anchorWorld(g.anchor);
    
    // Add slow drifting movement animation
    const moveSpeed = an.moveSpeed || 0.02;
    const moveRangeX = an.moveRangeX || 0.08;
    const moveRangeY = an.moveRangeY || 0.06;
    
    // Create slow, organic movement using different frequencies for X and Y
    const moveX = Math.sin(time * moveSpeed) * moveRangeX * fw;
    const moveY = Math.cos(time * moveSpeed * 0.7) * moveRangeY * fh; // Different frequency for Y
    
    const targetX = a.x + g.offFracX * fw + moveX;
    const targetY = a.y + g.offFracY * fh + moveY;
    m.position.x = targetX;
    m.position.y = targetY;
  }
}

function initGlowBlobsIfNeeded(){
  if (_glowInited) return;
  // Require head/shoulder bones to anchor
  if (!head) return;
  const { w: fw, h: fh } = _getFrustumSize(); // for initial sizing if needed
  
  // Dramatic warm amber/orange behind left shoulder, larger and more intense
  const orangeLeft = _createGlowBlob({
    name: 'GlowBlob_OrangeLeft',
    color: 0x810C01,  // More vibrant orange
    wFrac: 1.6, hFrac: 2.0,  // Much larger
    anchor: leftShoulder || head,
    offFracX: -0.6, offFracY: 0.6,  // Higher up, more to the left
    z: -45,
    intensity: 0.4,
    radius: 0.35,
    softness: 0.2,
    anim: { 
      speed: 0.5, 
      ampScale: 0.08, 
      ampIntensity: 0.25, 
      phase: 0.0,
      // Slow movement animation parameters
      moveSpeed: 0.015,   // Very slow drift speed
      moveRangeX: 0.12,   // Horizontal drift range (as fraction of frustum width)
      moveRangeY: 0.08    // Vertical drift range (as fraction of frustum height)
    }
  });
  
  // Expose references for easy tweaking
  window.glowBlobs = {
    orangeLeft,
    // Helper to update a blob's properties
    update: (blobRef, props) => {
      if (!blobRef || !blobRef.material) return;
      const g = blobRef.userData.glow;
      const mat = blobRef.material;
      if (props.color !== undefined) {
        const newColor = new THREE.Color(props.color);
        mat.uniforms.uTint.value.copy(newColor);
        g.baseColor.copy(newColor);
      }
      if (props.intensity !== undefined) {
        g.baseIntensity = props.intensity;
        mat.uniforms.uIntensity.value = props.intensity;
      }
      if (props.radius !== undefined) mat.uniforms.uRadius.value = props.radius;
      if (props.softness !== undefined) mat.uniforms.uSoftness.value = props.softness;
      if (props.wFrac !== undefined) g.wFrac = props.wFrac;
      if (props.hFrac !== undefined) g.hFrac = props.hFrac;
      if (props.offFracX !== undefined) g.offFracX = props.offFracX;
      if (props.offFracY !== undefined) g.offFracY = props.offFracY;
      if (props.z !== undefined) blobRef.position.z = props.z;
    }
  };
  
  _glowInited = true;
}

const hemLight = new THREE.HemisphereLight( 0xabd5f7, 0x000000, 40 );
scene.add( hemLight );

// =========================
// POINT & SPOT LIGHT SETUP
// =========================

// Strong warm red point light from below/front center (under-face glow)
const underfacePointLight = new THREE.PointLight(0xE60E00, 3000, 12); // color, intensity, range
underfacePointLight.position.set(0, 8, -4);
scene.add(underfacePointLight);
// const underfacePointLightHelper = new THREE.PointLightHelper(underfacePointLight, 20);
// scene.add(underfacePointLightHelper);

// Warm red spotlight from slightly below, angled up toward hairline
const redUnderHairSpot = new THREE.SpotLight(0xE60E00, 3500, 40, Math.PI / 3.6, 0.8, 1);
redUnderHairSpot.position.set(0, 5, 4.5); // below head, toward camera
redUnderHairSpot.target.position.set(0, 8, 2.5); // aim toward hairline
redUnderHairSpot.target.updateMatrixWorld();
redUnderHairSpot.castShadow = false; // no shadows for performance
scene.add(redUnderHairSpot);
scene.add(redUnderHairSpot.target);
// const redUnderHairSpotHelper = new THREE.SpotLightHelper(redUnderHairSpot);
// scene.add(redUnderHairSpotHelper);

// Warm red spotlight from front-right side
const redFrontRightSpot = new THREE.SpotLight(0xE60E00, 1000);
redFrontRightSpot.angle = Math.PI / 7; // narrow beam
redFrontRightSpot.penumbra = 1; // soft edge
redFrontRightSpot.decay = 0.8; // falloff
redFrontRightSpot.distance = 50;
redFrontRightSpot.position.set(8, 10, 7);
redFrontRightSpot.target.position.set(14, 25, -4);
redFrontRightSpot.target.updateMatrixWorld();
scene.add(redFrontRightSpot);
scene.add(redFrontRightSpot.target);
// const redFrontRightSpotHelper = new THREE.SpotLightHelper(redFrontRightSpot);
// scene.add(redFrontRightSpotHelper);

// Narrow warm red spotlight from far upper-right
const redUpperRightSpot = new THREE.SpotLight(0x880800, 1200);
redUpperRightSpot.angle = Math.PI / 28; // very narrow
redUpperRightSpot.penumbra = 1; // soft edge
redUpperRightSpot.decay = 1.1; // falloff
redUpperRightSpot.distance = 50;
redUpperRightSpot.position.set(8, 22, 32);
redUpperRightSpot.target.position.set(6, 28, 0);
redUpperRightSpot.target.updateMatrixWorld();
scene.add(redUpperRightSpot);
scene.add(redUpperRightSpot.target);
// const redUpperRightSpotHelper = new THREE.SpotLightHelper(redUpperRightSpot);
// scene.add(redUpperRightSpotHelper);

// Warm red spotlight from left side
const redLeftSpot = new THREE.SpotLight(0x880800, 100);
redLeftSpot.angle = Math.PI / 7;
redLeftSpot.penumbra = 0.3;
redLeftSpot.decay = 1.3;
redLeftSpot.distance = 12;
redLeftSpot.position.set(-7, 9, 3);
redLeftSpot.target.position.set(0, 17, 11);
redLeftSpot.target.updateMatrixWorld();
scene.add(redLeftSpot);
scene.add(redLeftSpot.target);
// const redLeftSpotHelper = new THREE.SpotLightHelper(redLeftSpot);
// scene.add(redLeftSpotHelper);

// Top-down cool bluish spotlight
const topCoolBlueSpot = new THREE.SpotLight(0x75B3CA, 150);
topCoolBlueSpot.angle = Math.PI / 5;
topCoolBlueSpot.penumbra = 0.1;
topCoolBlueSpot.decay = 1;
topCoolBlueSpot.distance = 8;
topCoolBlueSpot.position.set(0, 33, 12);
topCoolBlueSpot.target.position.set(0, 0, -5);
topCoolBlueSpot.target.updateMatrixWorld();
scene.add(topCoolBlueSpot);
scene.add(topCoolBlueSpot.target);
// const topCoolBlueSpotHelper = new THREE.SpotLightHelper(topCoolBlueSpot);
// scene.add(topCoolBlueSpotHelper);

// Top-down neutral gray spotlight from upper-left
const topGrayLeftSpot = new THREE.SpotLight(0x8D8D8D, 300);
topGrayLeftSpot.angle = Math.PI / 7;
topGrayLeftSpot.penumbra = 0.5;
topGrayLeftSpot.decay = 1;
topGrayLeftSpot.distance = 28;
topGrayLeftSpot.position.set(-8, 34, -3);
topGrayLeftSpot.target.position.set(-13, 0, 4);
topGrayLeftSpot.target.updateMatrixWorld();
scene.add(topGrayLeftSpot);
scene.add(topGrayLeftSpot.target);
// const topGrayLeftSpotHelper = new THREE.SpotLightHelper(topGrayLeftSpot);
// scene.add(topGrayLeftSpotHelper);

// Overhead neutral gray spotlight from slightly front-right
const overheadNeutralSpot = new THREE.SpotLight(0x8D8D8D, 100);
overheadNeutralSpot.angle = Math.PI / 10;
overheadNeutralSpot.penumbra = 1.6;
overheadNeutralSpot.decay = 1;
overheadNeutralSpot.distance = 16;
overheadNeutralSpot.position.set(0, 30, 14);  // above head, slightly forward
overheadNeutralSpot.target.position.set(2, 22, 11); // aiming toward upper face/hair
overheadNeutralSpot.target.updateMatrixWorld();
scene.add(overheadNeutralSpot);
scene.add(overheadNeutralSpot.target);
// const overheadNeutralSpotHelper = new THREE.SpotLightHelper(overheadNeutralSpot);
// scene.add(overheadNeutralSpotHelper);

// Collect all lights, remember their final intensities, and start at 10%
const allLights = [
  hemLight,
  underfacePointLight,
  redUnderHairSpot,
  redFrontRightSpot,
  redUpperRightSpot,
  redLeftSpot,
  topCoolBlueSpot,
  topGrayLeftSpot,
  overheadNeutralSpot
];

const lightFinalIntensities = new Map();
allLights.forEach(l => {
  if (!l) return;
  lightFinalIntensities.set(l, l.intensity);
  l.intensity = l.intensity * 0.1; // start at 10% before eyes turn on
});

// Call once before adding any RectAreaLight
// RectAreaLightUniformsLib.init();

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

new RGBELoader()
    .load(hdriUrl, (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;

        // Create a scene just for rotation
        const hdrScene = new THREE.Scene();
        const hdrSphere = new THREE.Mesh(
            new THREE.SphereGeometry(1, 60, 40),
            new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide })
        );

        hdrSphere.rotation.y = THREE.MathUtils.degToRad(-90); 
        hdrScene.add(hdrSphere);

        const envMap = pmremGenerator.fromScene(hdrScene).texture;

        scene.environment = envMap;
        scene.background = envMap;

        pmremGenerator.dispose();
});

let blackMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  side: THREE.DoubleSide,
  toneMapped: false,
  fog: false
});

// loading external GLTF head
let mixer, GLTFHead;

function loadGLTFHead(GLTFName) {
    const loader = new GLTFLoader();

    // Meshopt for geometry compression
    loader.setMeshoptDecoder(MeshoptDecoder);

    loader.load(GLTFName, function (gltf) {
        GLTFHead = gltf.scene;
        let GLTFAnimations = gltf.animations;

        currentTime = 0;

        manipulateModel(GLTFHead, GLTFAnimations);

        // Initialize scroll-based effects to match current page position before startup
        initializeScrollEffectsFromCurrentPosition();
        
        // Kick off startup sequence once model is in scene
        startStartupSequence();

    }, undefined, function (error) {
        console.error(error);
    });
}

loadGLTFHead(modelUrl);

let chin, neck, head, leftShoulder, rightShoulder;

function manipulateModel(model, animations) {
    
    mixer = new THREE.AnimationMixer(model);
    const windClip = THREE.AnimationClip.findByName(animations, 'Wind');
    if (windClip) mixer.clipAction(windClip).play();

    const materialConfigs = {
        Face: {
            metallic: 0.99,
            roughness: 0.38
        },
        Sweater: {
            metallic: 0,
            roughness: 1
        },
        Hair: {
            metallic: 1,
            roughness: 0.7
        }
    };

    const shadowMaskTexture = new THREE.TextureLoader().load(shadowMaskUrl);
    shadowMaskTexture.flipY = false;
    if (shadowMaskTexture) shadowMaskTexture.anisotropy = MAX_ANISOTROPY;

    // Helper: set max anisotropy on all textures a material may use
    function setMaterialMaxAnisotropy(mat){
      if (!mat) return;
      const maybeSet = (tex)=>{ if (tex && tex.isTexture) tex.anisotropy = Math.max(tex.anisotropy || 1, MAX_ANISOTROPY); };
      maybeSet(mat.map);
      maybeSet(mat.normalMap);
      maybeSet(mat.roughnessMap);
      maybeSet(mat.metalnessMap);
      maybeSet(mat.aoMap);
      maybeSet(mat.emissiveMap);
      maybeSet(mat.specularMap);
      maybeSet(mat.clearcoatNormalMap);
      maybeSet(mat.displacementMap);
    }

    // Helper: collect candidate names from node and a couple of ancestors
    function collectAncestorNamesLower(object3d) {
        const names = [];
        let current = object3d;
        for (let i = 0; i < 3 && current; i++) {
            if (current.name && typeof current.name === 'string') {
                names.push(current.name.toLowerCase());
            }
            current = current.parent;
        }
        return names;
    }

    // Helper: does any node/ancestor name equal or include token (case-insensitive)
    function nameMatches(object3d, token) {
        const t = token.toLowerCase();
        const pool = collectAncestorNamesLower(object3d);
        return pool.some(n => n === t || n.includes(t));
    }

    // Helper: find the config key that matches this node by name (node or ancestors)
    function getConfigKeyFor(object3d) {
        const pool = collectAncestorNamesLower(object3d);
        for (const key of Object.keys(materialConfigs)) {
            const k = key.toLowerCase();
            if (pool.some(n => n === k || n.includes(k))) return key;
        }
        return null;
    }

    model.traverse((child) => {
        if (child.type === 'SkinnedMesh') {
            child.frustumCulled = false;
            child.geometry.computeTangents();
        }
    if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
      // Sharpen texture filtering
      if (Array.isArray(child.material)) child.material.forEach(setMaterialMaxAnisotropy);
      else setMaterialMaxAnisotropy(child.material);

            // Add bloom to eyes (match node or ancestor names)
            if (nameMatches(child, 'eye')) {
                child.material.emissive = new THREE.Color('#0053ED');
                child.material.color.set('#2C2C2C');
                child.material.emissiveIntensity = 3;
                child.material.emissiveMap = child.material.map;
                bloomEffect.selection.add(child);
                // Track eyes for startup sequence
                child.userData.eyeOriginalEmissiveIntensity = child.material.emissiveIntensity;
                child.userData.eyeOriginalColor = child.material.color; // Store original color
                eyeMeshes.push(child);
            }

            // Apply black material to sweater_black by node/ancestor names
            if (nameMatches(child, 'sweater_black')) {
                child.material = blackMaterial;
            }
        }

        const cfgKey = child.isMesh ? getConfigKeyFor(child) : null;
        if (child.isMesh && cfgKey) {
            const params = materialConfigs[cfgKey];
            const mat = child.material;

            mat.metalness = params.metallic;
            mat.roughness = params.roughness;

            mat.onBeforeCompile = (shader) => {
                for (let key in params) {
                    if (key !== "metallic" && key !== "roughness") {
                        shader.uniforms[key] = { value: params[key] };
                    }
                }

                if (cfgKey === 'Face') {
                    shader.uniforms.shadowMask = { value: shadowMaskTexture };
                    shader.fragmentShader = `
                        uniform sampler2D shadowMask;
                    ` + shader.fragmentShader;
                }

                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <normal_fragment_maps>',
                    (cfgKey === 'Face') ? `
                    #include <normal_fragment_maps>
                    {
                      roughnessFactor = ${params.roughness.toFixed(3)};
                      float maskVal = texture2D(shadowMask, vUv).r;
                      diffuseColor.rgb *= (1.0 - maskVal);
                      roughnessFactor = mix(roughnessFactor, 1.0, maskVal);
                      metalnessFactor = mix(metalnessFactor, 0.0, maskVal);
                    }` : `#include <normal_fragment_maps>`
                );
            };

            setMaterialMaxAnisotropy(mat);
            mat.needsUpdate = true;
        }
    });

    // === Bone references ===
    model.traverse(o => {
        if (o.isBone && o.name === 'Chin') {
            chin = o;
            // Gate head look until startup finishes
            if (allowHeadLook) startHeadLook(chin);
        }
        if (o.isBone && o.name === 'Neck') neck = o;
        if (o.isBone && o.name === 'Head') head = o;
        if (o.isBone && o.name === 'Right_shoulder') rightShoulder = o;
        if (o.isBone && o.name === 'Left_shoulder') leftShoulder = o;
    });

    scene.add(model);

    // Chin pose: slight up during startup, default otherwise
    chin.rotation.x = startupActive ? (Math.PI / 2 - initialChinLiftRad) : Math.PI / 2;

  // Initialize glow blobs once bones are available
  initGlowBlobsIfNeeded();
}

// ------------------ head movement -----------------------------------------------

// --- Tunables ---
const DEGREE_LIMIT = 25;
const LOOK_DAMP    = 10;
const DEADZONE_DEG = 0.2;

// Breathing
const BREATH_SPEED_MS         = 0.0013;
const CHIN_BREATH_AMPL_RAD    = THREE.MathUtils.degToRad(1.1);
const SHOULDER_BREATH_AMPL    = 0.23;
const SHOULDER_PHASE          = Math.PI;
const BREATH_EASE_IN_MS       = 2000;

// Inactivity return
const RETURN_DAMP   = 4;

// Eases the *start* of the snap‑back after inactivity so it doesn’t jerk
const RETURN_EASE_MS = 4000;        // how long to ramp into the return motion
// When the window is being resized, treat rotations gently for a short settle period
const RESIZE_SETTLE_MS = 250;      // grace period after every resize event

// --- State ---
let mousecoords = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let lastMouseMoveTime = Date.now();
let _headLookClock = new THREE.Clock();

// Breathing state
let _breathClockMs = Date.now();
let _breathPhase   = 0;
let _chinBreathOffset = 0;
let _shoulderGain = 0;
let _shoulderStartMs = Date.now();
let _baseLeftShoulderY = null;
let _baseRightShoulderY = null;
let _chinGain = 0;
let _chinBreathActive = false;
let _chinStartMs = null;
let _wasInactive = false;          // tracks transition into inactivity
let _inactiveStartMs = 0;          // when inactivity began (for easing)
let _lastResizeMs = 0;             // timestamp of last resize event

function _clamp01(v){ return Math.max(0, Math.min(1, v)); }
function _easeInOutQuad(t){ t=_clamp01(t); return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }

if (!IS_TOUCH_DEVICE) {
  document.addEventListener('mousemove', (e) => {
    lastMouseMoveTime = Date.now();
    mousecoords = { x: e.clientX, y: e.clientY };
  }, { passive: true });
}

window.addEventListener('mouseleave', () => {
  mousecoords = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
});

function _markResize() {
  _lastResizeMs = Date.now();
  // While layout is fluid, steer target to center briefly to avoid random jumps
  mousecoords = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}
window.addEventListener('resize', _markResize, { passive: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', _markResize, { passive: true });
}

let _headLookJustStarted = false;
let _headLookStartMs = 0;
let _headLookInitialCoords = null;

function startHeadLook() {
  _headLookClock.getDelta();
  _headLookJustStarted = true;
  _headLookStartMs = Date.now();
  _headLookInitialCoords = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  _headLookRAF();
}
function stopHeadLook() {
  _headLookClock.stop();
}

function _headLookRAF() {
  const dt = _headLookClock.getDelta();
  const now = Date.now();

  // Detect inactivity window
  const inactive = (now - lastMouseMoveTime > inactivityThreshold);

  // Detect live-resize settling window
  const resizing = now - _lastResizeMs < RESIZE_SETTLE_MS;

  // Track transition into inactivity to start an ease-in ramp
  if (inactive && !_wasInactive) {
    _inactiveStartMs = now;
  }
  _wasInactive = inactive;

  // Compute return progress (0..1) used only while inactive
  const returnProgress = inactive ? _clamp01((now - _inactiveStartMs) / RETURN_EASE_MS) : 1;

  if (typeof chin !== 'undefined' && chin) {
    // Choose head target: center if inactive/resizing, else cursor
    const useCenter = IS_TOUCH_DEVICE || inactive || resizing;
    let targetCoords = useCenter ? { x: window.innerWidth / 2, y: window.innerHeight / 2 } : mousecoords;

    // Ease the first movement after startup
    if (_headLookJustStarted) {
      const easeDuration = 500; // ms
      const t = Math.min(1, (now - _headLookStartMs) / easeDuration);
      // Use cubic ease for organic start
      const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      targetCoords = {
        x: _headLookInitialCoords.x + (mousecoords.x - _headLookInitialCoords.x) * easeT,
        y: _headLookInitialCoords.y + (mousecoords.y - _headLookInitialCoords.y) * easeT
      };
      if (t >= 1) _headLookJustStarted = false;
    }

    moveJoint(targetCoords, chin, DEGREE_LIMIT, dt, inactive, resizing, returnProgress);
  }

  doBreathing();
  requestAnimationFrame(_headLookRAF);
}

// Simple breathing-only loop for touch devices (no head follow)
let _breathOnlyActive = false;
function startBreathingOnly(){
  if (_breathOnlyActive) return;
  _breathOnlyActive = true;
  const loop = () => { doBreathing(); requestAnimationFrame(loop); };
  loop();
}

function moveJoint(mouse, joint, degreeLimit, dt, inactive, resizing, returnProgress) {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const mx = (mouse && typeof mouse.x === 'number') ? mouse.x : cx;
  const my = (mouse && typeof mouse.y === 'number') ? mouse.y : cy;

  // Apply head movement restriction smoothly tied to scroll progress from section 1 to 2
  const scrollProgressNormalized = Math.min(currentScrollProgress * 3, 1.0); // Normalize 0-1/3 to 0-1
  const restrictionProgress = Math.max(0, scrollProgressNormalized - 0); // Start restriction immediately when scrolling begins
  const restrictionMultiplier = 1.0 - (restrictionProgress * (1.0 - headMovementRestriction));
  const effectiveDegreeLimit = degreeLimit * restrictionMultiplier;

  const degrees = getMouseDegrees(mx, my, effectiveDegreeLimit);
  const targetRotationY = -THREE.MathUtils.degToRad(degrees.x) / 2.5;
  const targetRotationZ = -THREE.MathUtils.degToRad(degrees.x);
  const targetRotationX = Math.PI / 2 + THREE.MathUtils.degToRad(degrees.y) + _chinBreathOffset;

  // Base damping: normal look vs gentle return
  const baseDamp = inactive ? RETURN_DAMP : LOOK_DAMP;
  const alphaBase = 1 - Math.exp(-baseDamp * (dt || 0.016));

  // Ease the *start* of the return so it doesn’t kick with a jerk
  const easeFactor = inactive ? _easeInOutQuad(returnProgress) : 1;  // ramps 0→1 smoothly

  // While resizing, further soften changes to avoid wobble
  const resizeSoftener = resizing ? 0.25 : 1; // very gentle while viewport is in flux

  const alpha = alphaBase * easeFactor * resizeSoftener;
  const dead  = THREE.MathUtils.degToRad(DEADZONE_DEG);

  const dx = targetRotationX - joint.rotation.x;
  const dy = targetRotationY - joint.rotation.y;
  const dz = targetRotationZ - joint.rotation.z;

  if (Math.abs(dx) < dead && Math.abs(dy) < dead && Math.abs(dz) < dead) {
    joint.rotation.set(targetRotationX, targetRotationY, targetRotationZ);
    return;
  }

  // Blend toward target with controlled easing (prevents snap/jerk)
  joint.rotation.x += dx * alpha;
  joint.rotation.y += dy * alpha;
  joint.rotation.z += dz * alpha;
}

function getMouseDegrees(x, y, degreeLimit) {
  let dx = 0, dy = 0;
  const w = { x: window.innerWidth, y: window.innerHeight };
  // Clamp to window bounds so off-screen targets don't over-rotate
  const cx = Math.max(0, Math.min(w.x, x));
  const cy = Math.max(0, Math.min(w.y, y));

  if (cx <= w.x / 2) dx = ((degreeLimit * ((w.x / 2 - cx) / (w.x / 2) * 100)) / 100) * -1;
  if (cx >= w.x / 2) dx = (degreeLimit * ((cx - w.x / 2) / (w.x / 2) * 100)) / 100;
  if (cy <= w.y / 2) dy = (((degreeLimit * 0.5) * ((w.y / 2 - cy) / (w.y / 2) * 100)) / 100) * -1;
  if (cy >= w.y / 2) dy = (degreeLimit * ((cy - w.y / 2) / (w.y / 2) * 100)) / 100;

  return { x: dx, y: dy };
}

function doBreathing() {
  // Hold breathing entirely during startup sequence
  if (!allowBreathing) return;

  if (typeof leftShoulder !== 'undefined' && leftShoulder && _baseLeftShoulderY === null) {
    _baseLeftShoulderY = leftShoulder.position.y;
  }
  if (typeof rightShoulder !== 'undefined' && rightShoulder && _baseRightShoulderY === null) {
    _baseRightShoulderY = rightShoulder.position.y;
  }

  const nowMs = Date.now();
  const deltaMs = nowMs - _breathClockMs;
  _breathClockMs = nowMs;
  _breathPhase += BREATH_SPEED_MS * deltaMs;

  _shoulderGain = Math.min(1, (nowMs - _shoulderStartMs) / BREATH_EASE_IN_MS);

  // Chin breathing active when breathing is allowed
  let chinShouldBeActive = true;

  if (chinShouldBeActive) {
    if (!_chinBreathActive) {
      _chinBreathActive = true;
      _chinStartMs = nowMs;
      _chinGain = 0;
    } else if (_chinStartMs != null) {
      _chinGain = Math.min(1, (nowMs - _chinStartMs) / BREATH_EASE_IN_MS);
    }
  } else {
    _chinBreathActive = false;
    _chinGain = 0;
    _chinStartMs = null;
  }

  const shoulderOffset = Math.sin(_breathPhase + SHOULDER_PHASE) * SHOULDER_BREATH_AMPL * _shoulderGain;
  _chinBreathOffset = Math.sin(_breathPhase) * CHIN_BREATH_AMPL_RAD * _chinGain;

  if (typeof leftShoulder !== 'undefined' && leftShoulder && _baseLeftShoulderY !== null) {
    leftShoulder.position.y = _baseLeftShoulderY + shoulderOffset;
  }
  if (typeof rightShoulder !== 'undefined' && rightShoulder && _baseRightShoulderY !== null) {
    rightShoulder.position.y = _baseRightShoulderY + shoulderOffset;
  }

  // If head-follow is disabled (touch devices or head look not allowed),
  // apply the chin breathing offset directly to the chin bone rotation.
  if (chin && (IS_TOUCH_DEVICE || !allowHeadLook)) {
    const baseX = Math.PI / 2;
    chin.rotation.x = baseX + _chinBreathOffset;
    // Keep Y/Z as-is; head-follow would normally manage those when enabled
  }
}

const clock = new THREE.Clock();

const smaaEffect = new SMAAEffect(undefined, undefined, SMAAPreset.MEDIUM);
// On touch devices we prefer crispness (higher DPR) over heavy AA; use a lighter SMAA preset
if (IS_TOUCH_DEVICE) {
  try { smaaEffect.preset = SMAAPreset.LOW; } catch {}
}

const hueSatEffect = new HueSaturationEffect({
    hue: 0.09,         // warmer tone
    saturation: -0.25    // slight vibrance
});
  
const brightnessContrastEffect = new BrightnessContrastEffect({
    brightness: -0.07,   // tweak if needed
    contrast: 0.07     // subtle punch
});

// Grain overlay from the overlay effects module
const { effect: grainEffect, pass: grainPass } = createGrainPass(camera);
// Dial down grain on phones to avoid perceived softness
if (IS_TOUCH_DEVICE) {
  try { updateGrain(grainEffect, { opacity: 0.04 }); } catch {}
}



// =================================== Resize logic + Adaptive Performance =================================

// ---- Device heuristics & base DPR caps ----
const MAX_EFFECTIVE_DPR = 1.75; // absolute safety ceiling
function detectDeviceProfile(){
  const ua = (navigator.userAgent || '').toLowerCase();
  const isMobile = /mobi|iphone|android/.test(ua) || (matchMedia && matchMedia('(pointer:coarse)').matches);
  const isTablet = (!isMobile && /ipad|tablet/.test(ua)) || (Math.min(screen.width, screen.height) >= 768 && Math.min(screen.width, screen.height) < 1100 && (window.devicePixelRatio||1) >= 1.5);
  const isMac = /mac/.test(ua);
  const isAppleSilicon = isMac && /apple/.test(navigator.vendor || '') && ('gpu' in navigator || /arm|apple/.test(ua));
  const isM1AirLike = isAppleSilicon && (window.devicePixelRatio||1) >= 2 && Math.max(screen.width, screen.height) <= 2560;
  const largeDisplay = Math.max(screen.width || 0, screen.height || 0) >= 2560;
  const cores = navigator.hardwareConcurrency || 0;
  const dpr = window.devicePixelRatio || 1;
  const isIPhone = /iphone/.test(ua);
  const isHighEndPhone = isMobile && ((isIPhone && cores >= 6) || (cores >= 8 && dpr >= 3));
  let category = 'desktop';
  let baseCapInitial = MAX_EFFECTIVE_DPR;
  let baseCapMax = MAX_EFFECTIVE_DPR;
  if (isMobile){
    category='phone';
    if (isHighEndPhone){
      // High-end phones can sustain higher internal resolution while still >60fps
      baseCapInitial = 1.6;  // noticeably sharper
      baseCapMax = 1.7;      // allow slight headroom if performance is great
    } else {
      // Typical phones: improved starting sharpness
      baseCapInitial = 1.35;
      baseCapMax = 1.5;
    }
  }
  else if (isTablet){ category='tablet'; baseCapInitial = 1.25; baseCapMax = 1.3; }
  else if (isM1AirLike){ category='fanless'; baseCapInitial = 1.25; baseCapMax = 1.35; }
  else { // desktop
    if (largeDisplay){
      // Start conservative on large 27" 4K: similar to old logic (~1.16) but allow upgrade if ample headroom
      baseCapInitial = 1.18; // starting ceiling
      baseCapMax = 1.55;     // allow later upgrades but not full 1.75 on huge surface
    } else {
      baseCapInitial = 1.55;
      baseCapMax = 1.75;
    }
  }
  baseCapInitial = Math.min(baseCapInitial, window.devicePixelRatio || 1);
  baseCapMax = Math.min(baseCapMax, window.devicePixelRatio || 1);
  return { category, baseCapInitial, baseCapMax, baseCapCurrent: baseCapInitial, largeDisplay };
}
const __deviceProfile = detectDeviceProfile();

// Quantized DPR buckets (multipliers applied to baseCap) – descending order
// Keep buckets relatively high to avoid overly soft image on phones
const DPR_BUCKETS = [1.0, 0.9, 0.8];
let _dprBucketIndex = 0; // start at full quality of current baseCapCurrent

// Effect quality tiers prioritizing subtle internal resolution drops before DPR buckets
// level 0 = best, higher = more aggressive downscale
const EFFECT_QUALITY_LEVELS = [
  { name:'ultra', bloomScale:1.0,  reededScale:1.0 },
  { name:'high',  bloomScale:0.82, reededScale:0.9 },
  { name:'med',   bloomScale:0.68, reededScale:0.8 },
  { name:'low',   bloomScale:0.55, reededScale:0.7 } // reserve for very heavy scenes
];
let _effectQualityLevel = 0;

// Performance adaptation thresholds
const PERF_FPS_DROP_THRESHOLD = 55;        // trigger lowering when sustained below
const PERF_FPS_RAISE_THRESHOLD = 65;       // must be at/above this to consider raising
const PERF_DEGRADE_MIN_DURATION = 4000;    // ms of continuous low perf before degrading
const PERF_UPGRADE_MIN_DURATION = 6000;    // ms of sustained high perf before upgrading
const PERF_CHANGE_DEBOUNCE = 1300;         // ms between any two changes

// EMA smoothing (~1s window). We'll derive alpha dynamically per frame.
const EMA_WINDOW_SECONDS = 1.0;
let _emaFrameTime = 1/60; // start optimistic
let _lastPerfChangeTime = performance.now();
let _lowPerfAccum = 0;
let _highPerfAccum = 0;
let _lastEmaFPS = 60;

// Track canvas CSS size for re-applying on DPR changes without layout jumps
let _lastCSSW = window.innerWidth; let _lastCSSH = window.innerHeight;

// Resume/settling guard state
let _resumeGuardUntil = 0;           // time until which downscales are forbidden
let _resumeIgnoreFrames = 0;         // number of frames to ignore in EMA/scaler
let _postResumeDebounceUntil = 0;    // additional debounce window after guard

function _triggerResumeGuard(){
  const now = performance.now();
  _resumeGuardUntil = now + 4500;         // forbid downscales ~4.5s
  _resumeIgnoreFrames = 60;               // ignore first ~60 frames
  _postResumeDebounceUntil = now + 7000;  // extra debounce for a bit after
  // Reset EMA and accumulators
  _emaFrameTime = 1/60;
  _lowPerfAccum = 0; _highPerfAccum = 0;
  _lastPerfChangeTime = now; // also pushes next allowed change
}

// Hook resume-like events
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _triggerResumeGuard();
}, { passive: true });
window.addEventListener('focus', _triggerResumeGuard, { passive: true });
window.addEventListener('pageshow', _triggerResumeGuard, { passive: true });

function applyEffectQuality(){
  const tier = EFFECT_QUALITY_LEVELS[_effectQualityLevel];
  if (!tier) return;
  // Do NOT change bloom in real time – it's perceptible. Keep bloom at its initial resolution.
  // Only adjust reeded internal resolution subtly.
  try {
    if (_reedEffect && typeof setReededResolution === 'function') {
      setReededResolution(_reedEffect, Math.floor(_lastCSSW * tier.reededScale), Math.floor(_lastCSSH * tier.reededScale));
    }
  } catch(e){ /* silent */ }
}

function currentTargetPixelRatio(){
  const base = __deviceProfile.baseCapCurrent;
  const bucketMul = DPR_BUCKETS[_dprBucketIndex] || 1.0;
  return Math.min(base * bucketMul, MAX_EFFECTIVE_DPR, window.devicePixelRatio || 1);
}

function _applyRendererPixelRatio(){
  const pr = currentTargetPixelRatio();
  renderer.setPixelRatio(pr);
  renderer.setSize(_lastCSSW, _lastCSSH, false);
  composer.setSize(_lastCSSW, _lastCSSH);
  // Update dependent resolutions (vignette wants framebuffer resolution)
  const epr = pr; // effective pixel ratio used
  resizeRendererAndComposer._epr = pr;
  if (_vignetteEffect) setBottomVignetteResolution(_vignetteEffect, Math.floor(_lastCSSW * epr), Math.floor(_lastCSSH * epr));
  applyEffectQuality();
  // Pixel budget check (in case baseCapCurrent changed before this call)
  if (typeof enforcePixelBudget === 'function') enforcePixelBudget();
}

// Replace old computation function (kept name for legacy calls)
function computeEffectivePixelRatio(){
  return currentTargetPixelRatio();
}

function _effectiveDebounceMs(now){
  return PERF_CHANGE_DEBOUNCE + (now < _postResumeDebounceUntil ? 700 : 0);
}

function attemptDegrade(now){
  if (now < _resumeGuardUntil) return; // downscales forbidden during guard
  if (now - _lastPerfChangeTime < _effectiveDebounceMs(now)) return;
  // First try effect quality
  if (_effectQualityLevel < EFFECT_QUALITY_LEVELS.length - 1){
    const prevTier = EFFECT_QUALITY_LEVELS[_effectQualityLevel].name;
    _effectQualityLevel++;
    const newTier = EFFECT_QUALITY_LEVELS[_effectQualityLevel].name;
    applyEffectQuality();
  _lastPerfChangeTime = now;
  window.__perfDebug && console.log('[Perf] Degraded effect tier ->', newTier);
  if (typeof _logChange === 'function') _logChange('Tier ↓', prevTier, newTier, `EMA ${_lastEmaFPS.toFixed(1)} < ${PERF_FPS_DROP_THRESHOLD} for ${PERF_DEGRADE_MIN_DURATION}ms`);
    return;
  }
  // Then drop DPR bucket (if possible)
  if (_dprBucketIndex < DPR_BUCKETS.length - 1){
    const prevB = DPR_BUCKETS[_dprBucketIndex];
    _dprBucketIndex++;
    const newB = DPR_BUCKETS[_dprBucketIndex];
    _applyRendererPixelRatio();
  _lastPerfChangeTime = now;
  window.__perfDebug && console.log('[Perf] Dropped DPR bucket ->', newB);
  if (typeof _logChange === 'function') _logChange('Bucket ↓', String(prevB), String(newB), `EMA ${_lastEmaFPS.toFixed(1)} < ${PERF_FPS_DROP_THRESHOLD} for ${PERF_DEGRADE_MIN_DURATION}ms`);
  }
}

// Pixel budget: cap internal pixel count to avoid needless GPU usage on large 4K monitors
const PIXEL_BUDGET = 9_000_000; // ~ between 1440p@1.5x and 4K@1.0x
function enforcePixelBudget(){
  let pr = currentTargetPixelRatio();
  let internalPixels = _lastCSSW * _lastCSSH * pr * pr;
  let changed = false;
  while (internalPixels > PIXEL_BUDGET && (_dprBucketIndex < DPR_BUCKETS.length - 1)){
    _dprBucketIndex++; // drop bucket
    pr = currentTargetPixelRatio();
    internalPixels = _lastCSSW * _lastCSSH * pr * pr;
    changed = true;
  }
  if (changed) {
    _applyRendererPixelRatio();
    window.__perfDebug && console.log('[Perf] Enforced pixel budget, DPR bucket now', DPR_BUCKETS[_dprBucketIndex]);
    if (typeof _logChange === 'function') _logChange('Budget', '-', String(DPR_BUCKETS[_dprBucketIndex]), `>${(PIXEL_BUDGET/1e6).toFixed(1)} MP framebuffer`);
  }
}

function attemptUpgrade(now){
  if (now - _lastPerfChangeTime < _effectiveDebounceMs(now)) return;
  // Prefer restoring DPR first (visual crispness) if we've lowered it
  if (_dprBucketIndex > 0){
    const prevB = DPR_BUCKETS[_dprBucketIndex];
    _dprBucketIndex--;
    const newB = DPR_BUCKETS[_dprBucketIndex];
    _applyRendererPixelRatio();
  _lastPerfChangeTime = now;
  window.__perfDebug && console.log('[Perf] Raised DPR bucket ->', newB);
    if (typeof _logChange === 'function') _logChange('Bucket ↑', String(prevB), String(newB), `EMA ${_lastEmaFPS.toFixed(1)} ≥ ${PERF_FPS_RAISE_THRESHOLD} for ${PERF_UPGRADE_MIN_DURATION}ms`);
    return;
  }
  // Then restore effect quality
  if (_effectQualityLevel > 0){
    const prevTier = EFFECT_QUALITY_LEVELS[_effectQualityLevel].name;
    _effectQualityLevel--;
    const newTier = EFFECT_QUALITY_LEVELS[_effectQualityLevel].name;
    applyEffectQuality();
  _lastPerfChangeTime = now;
  window.__perfDebug && console.log('[Perf] Upgraded effect tier ->', newTier);
    if (typeof _logChange === 'function') _logChange('Tier ↑', prevTier, newTier, `EMA ${(_lastEmaFPS).toFixed(1)} ≥ ${PERF_FPS_RAISE_THRESHOLD} for ${PERF_UPGRADE_MIN_DURATION}ms`);
    return;
  }
  // Finally, if everything is maxed and we are still very healthy, allow raising baseCapCurrent slightly (for desktops only)
  if (__deviceProfile.category === 'desktop' && __deviceProfile.baseCapCurrent < __deviceProfile.baseCapMax){
    const prev = __deviceProfile.baseCapCurrent;
    __deviceProfile.baseCapCurrent = Math.min(__deviceProfile.baseCapMax, __deviceProfile.baseCapCurrent + 0.1);
    _applyRendererPixelRatio();
  _lastPerfChangeTime = now;
  window.__perfDebug && console.log('[Perf] Increased desktop baseCapCurrent ->', __deviceProfile.baseCapCurrent.toFixed(2));
  if (typeof _logChange === 'function') _logChange('Desktop baseCap ↑', prev.toFixed(2), __deviceProfile.baseCapCurrent.toFixed(2), '');
  }
}

function perfAdaptiveUpdate(delta){
  // delta already in seconds
  const now = performance.now();
  const alpha = 1 - Math.exp(-delta / EMA_WINDOW_SECONDS); // continuous-time EMA
  const frameTime = delta; // seconds
  // Ignore the first ~N frames after resume: keep EMA stable and skip actions
  if (_resumeIgnoreFrames > 0){
    _resumeIgnoreFrames--;
    // keep EMA as-is; also keep debug updated
    if (window.__perfDebug){
      window.__perfDebug.resumeGuardMs = Math.max(0, _resumeGuardUntil - now);
      window.__perfDebug.ignoreFrames = _resumeIgnoreFrames;
    }
    return;
  }

  _emaFrameTime = _emaFrameTime + alpha * (frameTime - _emaFrameTime);
  const emaFPS = 1 / _emaFrameTime;
  _lastEmaFPS = emaFPS;

  if (emaFPS < PERF_FPS_DROP_THRESHOLD){
    _lowPerfAccum += delta * 1000; // ms
    _highPerfAccum = 0;
    if (_lowPerfAccum >= PERF_DEGRADE_MIN_DURATION){
      attemptDegrade(now);
      _lowPerfAccum = 0; // reset after change
    }
  } else if (emaFPS >= PERF_FPS_RAISE_THRESHOLD){
    _highPerfAccum += delta * 1000; // ms
    _lowPerfAccum = 0;
  if (_highPerfAccum >= PERF_UPGRADE_MIN_DURATION){
      attemptUpgrade(now);
      _highPerfAccum = 0;
    }
  } else {
    // In middle band – decay accumulators gently to require sustained trends
    _lowPerfAccum = Math.max(0, _lowPerfAccum - delta * 400);
    _highPerfAccum = Math.max(0, _highPerfAccum - delta * 400);
  }
  // Optional debug hook
  if (window.__perfDebug){
    window.__perfDebug.emaFPS = emaFPS.toFixed(1);
    window.__perfDebug.bucket = DPR_BUCKETS[_dprBucketIndex];
    window.__perfDebug.effectTier = EFFECT_QUALITY_LEVELS[_effectQualityLevel].name;
  window.__perfDebug.baseCapCurrent = __deviceProfile.baseCapCurrent;
  window.__perfDebug.resumeGuardMs = Math.max(0, _resumeGuardUntil - now);
  window.__perfDebug.ignoreFrames = _resumeIgnoreFrames;
  }
  // Update HUD
  _initPerfHUD();
  _updatePerfHUD(150);
}

// -------------------- Lightweight Perf HUD --------------------
let _perfHUD = null;
let _perfHUDLastUpdate = 0;
const _perfLog = [];

function _initPerfHUD(){
  if (_perfHUD) return;
  // Inject stylesheet for responsive/collapsible HUD with color tags
  const styleId = 'perf-hud-style';
  if (!document.getElementById(styleId)){
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = `
      #perf-hud{position:fixed;top:8px;left:8px;z-index:10000;background:rgba(12,12,12,.72);color:#e8efff;border-radius:10px;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;backdrop-filter:saturate(1.15) blur(2px);box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:auto;max-width:80vw}
      #perf-hud .hd{display:flex;align-items:center;gap:6px;font-weight:700;padding:8px 10px;cursor:pointer;user-select:none}
      #perf-hud .bd{white-space:pre-wrap;padding:0 10px 8px 10px}
      #perf-hud .lg{white-space:pre-wrap;margin:6px 0 8px 0;border-top:1px solid rgba(255,255,255,.08);padding:6px 10px 0 10px;max-height:140px;overflow:auto}
      #perf-hud.collapsed .bd, #perf-hud.collapsed .lg{display:none}
      #perf-hud .tag{display:inline-block;font-weight:700;padding:0 6px;border-radius:6px;color:#111}
      #perf-hud .tag.up{background:#16c784}
      #perf-hud .tag.down{background:#ff6b6b}
      #perf-hud .tag.budget{background:#fbbf24}
      #perf-hud .ts{opacity:.7}
      @media (max-width:640px){
        #perf-hud{top:6px;left:6px;border-radius:8px}
        #perf-hud .hd{padding:6px 8px;font-size:11px}
        #perf-hud .bd{padding:0 8px 6px 8px;font-size:11px}
        #perf-hud .lg{padding:6px 8px 0 8px;max-height:100px;font-size:10px}
      }
    `;
    document.head.appendChild(st);
  }

  const wrap = document.createElement('div');
  wrap.id = 'perf-hud';
  wrap.className = 'collapsed';

  const head = document.createElement('div'); head.className='hd';
  const caret = document.createElement('span'); caret.textContent='▸'; caret.style.opacity='.8';
  const title = document.createElement('span'); title.textContent = 'Perf';
  const mini = document.createElement('span'); mini.style.opacity='.85'; mini.style.fontWeight='600'; mini.style.marginLeft='4px'; mini.className='mini';
  head.appendChild(caret); head.appendChild(title); head.appendChild(mini);

  const body = document.createElement('div'); body.className='bd';
  const log = document.createElement('div'); log.className='lg';
  wrap.appendChild(head); wrap.appendChild(body); wrap.appendChild(log);
  document.body.appendChild(wrap);
  _perfHUD = { el: wrap, head, body, log, caret, mini };

  // Toggle expand/collapse on click/tap
  const toggle = ()=>{
    const collapsed = wrap.classList.toggle('collapsed');
    wrap.setAttribute('aria-expanded', String(!collapsed));
    _updatePerfHUD(0);
  };
  head.addEventListener('click', toggle, {passive:true});
  head.addEventListener('touchstart', (e)=>{ e.preventDefault(); toggle(); }, {passive:false});
}

function _describeQuality(){
  const tier = EFFECT_QUALITY_LEVELS[_effectQualityLevel]?.name || 'ultra';
  const bucket = DPR_BUCKETS[_dprBucketIndex] ?? 1.0;
  const pr = currentTargetPixelRatio().toFixed(2);
  return `FPS: ${_lastEmaFPS.toFixed(1)}\nTier: ${tier}  DPR: ${pr} (bucket ${bucket})`;
}

function _updatePerfHUD(throttleMs = 150){
  const now = performance.now();
  if (!_perfHUD || (now - _perfHUDLastUpdate) < throttleMs) return;
  _perfHUDLastUpdate = now;
  const collapsed = _perfHUD.el.classList.contains('collapsed');
  // Header caret + compact line
  _perfHUD.caret.textContent = collapsed ? '▸' : '▾';
  const ema = (_lastEmaFPS && isFinite(_lastEmaFPS)) ? `${_lastEmaFPS.toFixed(0)}fps` : '';
  const bucket = (typeof _dprBucketIndex==='number') ? `DPR ${DPR_BUCKETS[_dprBucketIndex]}` : '';
  const tier = (typeof _effectQualityLevel==='number') ? EFFECT_QUALITY_LEVELS[_effectQualityLevel].name : '';
  _perfHUD.mini.textContent = [ema, bucket, tier].filter(Boolean).join(' · ');

  // Body and Log
  _perfHUD.body.textContent = _describeQuality();
  if (_perfLog.length){
    const last = _perfLog.slice(-8);
    const html = last.map(_renderPerfLogLine).join('');
    _perfHUD.log.innerHTML = html;
  }
}

function _logPerfEvent(msg){
  const t = new Date();
  const hh = String(t.getHours()).padStart(2,'0');
  const mm = String(t.getMinutes()).padStart(2,'0');
  const ss = String(t.getSeconds()).padStart(2,'0');
  _perfLog.push(`${hh}:${mm}:${ss} ${msg}`);
  _updatePerfHUD(0);
}

// Helper to format richer changes consistently
function _logChange(kind, from, to, reason){
  const t = new Date();
  const hh = String(t.getHours()).padStart(2,'0');
  const mm = String(t.getMinutes()).padStart(2,'0');
  const ss = String(t.getSeconds()).padStart(2,'0');
  _perfLog.push({ ts: `${hh}:${mm}:${ss}`, kind, from, to, reason });
  _updatePerfHUD(0);
}

function _renderPerfLogLine(entry){
  // Legacy string entries support
  if (typeof entry === 'string'){
    const safe = entry.replace(/[&<>]/g, s=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[s]));
    return `<div>• ${safe}</div>`;
  }
  const {ts, kind, from, to, reason} = entry;
  const isUp = kind.includes('↑');
  const isDown = kind.includes('↓');
  const cls = kind.startsWith('Budget') ? 'budget' : (isUp ? 'up' : (isDown ? 'down' : ''));
  const base = kind.replace(' ↑','').replace(' ↓','');
  const tag = `<span class="tag ${cls}">${base}${isUp?' ↑':isDown?' ↓':''}</span>`;
  const parts = [ `<span class="ts">${ts}</span> — ${tag} ${from} → ${to}` ];
  if (reason) parts.push(` — ${reason}`);
  return `<div>${parts.join('')}</div>`;
}

// Removed grain pulse smoother per request

// Expose debug controls
window.__perfDebug = {
  get status(){ return { dpr: currentTargetPixelRatio(), bucket: DPR_BUCKETS[_dprBucketIndex], tier: EFFECT_QUALITY_LEVELS[_effectQualityLevel].name, baseCapCurrent: __deviceProfile.baseCapCurrent, baseCapMax: __deviceProfile.baseCapMax }; },
  forceBucket(i){ _dprBucketIndex = Math.min(Math.max(0,i), DPR_BUCKETS.length-1); _applyRendererPixelRatio(); },
  forceTier(i){ _effectQualityLevel = Math.min(Math.max(0,i), EFFECT_QUALITY_LEVELS.length-1); applyEffectQuality(); },
  setBaseCap(v){ __deviceProfile.baseCapCurrent = Math.min(Math.max(0.5, v), __deviceProfile.baseCapMax); _applyRendererPixelRatio(); },
  emaFPS: 60,
  bucket: 1.0,
  effectTier: 'ultra'
};

function updateOrthoFrustum(cam, aspect) {
  // Base values
  let size = frustumSize;
  let heightOffset = frustumHeight;

  // Orientation check
  const vw = window.visualViewport ? Math.floor(window.visualViewport.width)  : window.innerWidth;
  const vh = window.visualViewport ? Math.floor(window.visualViewport.height) : window.innerHeight;
  const isPortrait = vh >= vw;

  // Device-responsive tweaks
  if (isPortrait) {
    // Breakpoints: Phones (portrait) if width < 450px, otherwise tablet
    const isPhonePortrait = vw < 450;
    if (isPhonePortrait) {
      // Phones (portrait): zoom out a bit more and nudge scene up
      size = frustumSize * 1.52; // Decrease multiplier to increase zoom
      heightOffset = frustumHeight - 11; // move scene up
    } else {
      // Tablets (portrait): zoom out a bit, keep height offset as-is
      size = frustumSize * 1.4;
      heightOffset = frustumHeight;
    }
  }

  cam.left   = -size * aspect / 2;
  cam.right  =  size * aspect / 2;
  cam.top    =  size + heightOffset;
  cam.bottom =  heightOffset;
  cam.updateProjectionMatrix();

  // Update the bottom cover plane based on how much we shifted the scene up
  // Cover height equals the vertical offset applied (frustumHeight - heightOffset).
  // Keep it confined to the bottom area so it only slightly overlaps the model's bottom edge.
  const coverHeight = Math.max(0, frustumHeight - heightOffset);
  updateBottomCoverPlane(coverHeight);
}

function setCanvasCSSSize(canvas, w, h) {
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

function resizeRendererAndComposer(renderer, composer, w, h) {
  _lastCSSW = w; _lastCSSH = h;
  _applyRendererPixelRatio(); // centralizes pixel ratio + dependent sizes
  enforcePixelBudget();
}

let resizeRAF = 0;
function handleResize() {
  if (resizeRAF) return;
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = 0;

    const vw = window.visualViewport ? Math.floor(window.visualViewport.width)  : window.innerWidth;
    const vh = window.visualViewport ? Math.floor(window.visualViewport.height) : window.innerHeight;

  // Oversize canvas height on portrait devices to buffer iOS chrome show/hide
  const isPortrait = vh >= vw;
  const isPhonePortrait = isPortrait && vw < 500;
  const isTabletPortrait = isPortrait && vw >= 500 && vw <= 1100; // iPad range
  const cssH = isPhonePortrait ? Math.floor(vh * 1.15) : (isTabletPortrait ? Math.floor(vh * 1.08) : vh);

    if (theCanvas) setCanvasCSSSize(theCanvas, vw, cssH);

    const aspect = vw / cssH;
    updateOrthoFrustum(camera, aspect);

  resizeRendererAndComposer(renderer, composer, vw, cssH);
  if (_reedEffect) setReededResolution(_reedEffect, vw, cssH);
  if (_vignetteEffect) setBottomVignetteResolution(_vignetteEffect, Math.floor(vw * (resizeRendererAndComposer._epr || 1)), Math.floor(cssH * (resizeRendererAndComposer._epr || 1)));
  // Resize depth RT if present
  if (animate._depthRT) animate._depthRT.setSize(vw, cssH);
    // Fit gradient background to the frustum
    positionGradientBackgroundFromFrustum();
  });
}

if (IS_TOUCH_DEVICE) {
  // On touch devices: handle orientation and visual viewport changes (iOS Safari UI chrome)
  window.addEventListener('orientationchange', handleResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleResize, { passive: true });
  }
} else {
  // On non-touch: respond to full resize and visualViewport changes
  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('orientationchange', handleResize, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleResize, { passive: true });
  }
}

// Handle scroll to gradually apply reeded glass effect
let currentSection = 0;
let isScrolling = false;
let scrollTimeout;
let currentScrollProgress = 0;
let baseExposure = 1.0; // Store the base exposure value
let scrollRefractionMultiplier = 3.0; // Configurable refraction multiplier
let headMovementRestriction = 0.16; // 10% of normal movement when scrolling
let baseEyeIntensity = 6.0; // Store the base eye emissive intensity
let baseSaturation = -0.25; // Store the base saturation value

// Update saturation based on scroll progress
function updateSaturationForScroll(scrollProgress) {
  if (!hueSatEffect) return;
  
  // Reduce saturation further when scrolled (more desaturated)
  // Base saturation: -0.25, Target when scrolled: -0.8 (much more desaturated)
  const targetSaturation = baseSaturation - (scrollProgress * 0.0); // Reduces saturation by 0.30 when fully scrolled
  hueSatEffect.saturation = targetSaturation;
}

// Compute exposure as a smooth function across part 2 -> 3
// 0.0-0.5: keep baseExposure; 0.5-1.0: smoothly lerp to darker exposure
function computeExposureForScroll(scrollProgress) {
  const start = 0.5; // begin darkening at start of part 3 transition
  const end = 1.0;   // reach final darkness at the end
  const t = THREE.MathUtils.clamp((scrollProgress - start) / (end - start), 0, 1);
  // Smoothstep easing for a gentle curve
  const eased = t * t * (3 - 2 * t);
  const finalFactor = 0.7; // final exposure factor at end of part 3 (unify target)
  // Lerp from baseExposure to baseExposure * finalFactor
  return baseExposure * (1 - eased * (1 - finalFactor));
}

// Determine glass effect configuration based on scroll progress
function getGlassModeForProgress(scrollProgress) {
  // scrollProgress is 0-1 across all 3 sections
  // 0.0-0.5: Page 1 to Page 2 (left half gets glass, right half stays clear)
  // 0.5-1.0: Page 2 to Page 3 (right half gradually gets glass too, reaching full coverage)
  
  if (scrollProgress <= 0.5) {
    // First half: transitioning from page 1 to page 2
    // Enable split-screen mode with left side getting increasing glass effect
    const localProgress = scrollProgress * 2.0; // Normalize to 0-1 for this transition
    return {
      splitScreen: true,
      boundary: 0.5, // Split at 50% (left half gets effect)
      effectProgress: localProgress,
      rightSideProgress: 0.0 // Right side has no effect yet
    };
  } else {
    // Second half: transitioning from page 2 to page 3
    // Right side gradually gets glass effect while left side maintains full effect
    const localProgress = (scrollProgress - 0.5) * 2.0; // Normalize to 0-1 for this transition
    return {
      splitScreen: true, // Keep split-screen mode
      boundary: 0.5, // Keep boundary at 50%
      effectProgress: 1.0, // Left side maintains full effect
      rightSideProgress: localProgress // Right side gradually gets effect
    };
  }
}

// Initialize effects based on current scroll position (for page reloads)
function _getSectionCSSHeight(){
  // Prefer measuring a section element to account for svh/dvh and our buffers
  const sec = document.querySelector('.content-section');
  if (sec) return sec.getBoundingClientRect().height;
  return window.visualViewport ? Math.floor(window.visualViewport.height) : window.innerHeight;
}

function initializeScrollEffectsFromCurrentPosition() {
  const scrollY = window.scrollY;
  const sectionHeight = _getSectionCSSHeight();
  const totalSections = 3; // Now we have 3 sections
  const scrollProgress = Math.min(scrollY / (sectionHeight * (totalSections - 1)), 1.0); // Normalize to 0-1 across all sections
  
  // Set the current scroll progress and section
  currentScrollProgress = scrollProgress;
  currentSection = Math.round(scrollY / sectionHeight);
  
  // Determine glass effect mode based on section
  const glassModeConfig = getGlassModeForProgress(scrollProgress);
  
  // Apply effects immediately without animation to match scroll position
  if (_reedEffect) {
    setReededScrollProgress(_reedEffect, glassModeConfig.effectProgress);
    setReededScrollRefractionMultiplier(_reedEffect, scrollRefractionMultiplier);
    setReededSplitScreenMode(_reedEffect, glassModeConfig.splitScreen, glassModeConfig.boundary, glassModeConfig.rightSideProgress);
  }
  
  // Update gradient colors for scroll position
  updateGradientColorsForScroll(scrollProgress);
  
  // Update saturation for scroll position
  updateSaturationForScroll(scrollProgress);
  
  // baseExposure should always remain at the original value
  baseExposure = 1.0;
  
  // Note: Initial exposure will be set correctly by the startup sequence based on currentScrollProgress
  
  // Also set renderer exposure to match current scroll smoothly (avoids jumps on reload)
  if (renderer) {
    renderer.toneMappingExposure = computeExposureForScroll(scrollProgress);
  }

  console.log(`Initialized scroll effects: progress=${scrollProgress.toFixed(2)}, section=${currentSection}, baseExposure=${baseExposure}`);
}

function updateReededGlassProgress(progress) {
  if (_reedEffect) {
    setReededScrollProgress(_reedEffect, progress);
    // Update refraction multiplier
    setReededScrollRefractionMultiplier(_reedEffect, scrollRefractionMultiplier);
  }
  // Note: Exposure is now handled directly in scroll handlers for better timing
}

function snapToSection(sectionIndex) {
  const sectionHeight = _getSectionCSSHeight();
  const targetY = sectionIndex * sectionHeight;
  const totalSections = 3;
  const targetProgress = sectionIndex / (totalSections - 1); // Normalize to 0-1 across all sections
  // Exposure will be driven by handleScroll() as the window scrolls; avoid conflicting tweens here
  
  window.scrollTo({
    top: targetY,
    behavior: 'smooth'
  });
  currentSection = sectionIndex;
  
  // Smoothly animate reeded glass progress using GSAP
  gsap.to({ progress: currentScrollProgress }, {
    progress: targetProgress,
    duration: 0.8,
    ease: "power2.out",
    onUpdate: function() {
      currentScrollProgress = this.targets()[0].progress;
      
      // Get glass mode configuration for current progress
      const glassModeConfig = getGlassModeForProgress(currentScrollProgress);
      
      // Update reeded glass but skip exposure changes since we're handling it above
      if (_reedEffect) {
        setReededScrollProgress(_reedEffect, glassModeConfig.effectProgress);
        setReededScrollRefractionMultiplier(_reedEffect, scrollRefractionMultiplier);
        setReededSplitScreenMode(_reedEffect, glassModeConfig.splitScreen, glassModeConfig.boundary, glassModeConfig.rightSideProgress);
      }
      // Update gradient background colors during smooth transition
      updateGradientColorsForScroll(currentScrollProgress);
      // Update saturation during smooth transition
      updateSaturationForScroll(currentScrollProgress);
      // Keep exposure in sync during GSAP-driven progress changes as well
      if (renderer) {
        renderer.toneMappingExposure = computeExposureForScroll(currentScrollProgress);
      }
    }
  });
}

function handleScroll() {
  if (isScrolling) return;
  
  const scrollY = window.scrollY;
  const sectionHeight = _getSectionCSSHeight();
  const totalSections = 3;
  const scrollProgress = Math.min(scrollY / (sectionHeight * (totalSections - 1)), 1.0); // Normalize to 0-1 across all sections
  
  // Update reeded glass smoothly based on scroll position
  currentScrollProgress = scrollProgress;
  
  // Get glass mode configuration for current progress
  const glassModeConfig = getGlassModeForProgress(scrollProgress);
  
  // Update reeded glass effects
  if (_reedEffect) {
    setReededScrollProgress(_reedEffect, glassModeConfig.effectProgress);
    setReededScrollRefractionMultiplier(_reedEffect, scrollRefractionMultiplier);
    setReededSplitScreenMode(_reedEffect, glassModeConfig.splitScreen, glassModeConfig.boundary, glassModeConfig.rightSideProgress);
  }
  
  // Update gradient background colors
  updateGradientColorsForScroll(scrollProgress);
  
  // Update saturation based on scroll position
  updateSaturationForScroll(scrollProgress);
  
  // Update exposure smoothly based on scroll position (no step change)
  if (renderer) {
    renderer.toneMappingExposure = computeExposureForScroll(scrollProgress);
  }
  
  // Determine target section for snapping
  const newSection = Math.round(scrollY / sectionHeight);
  const targetSection = Math.max(0, Math.min(2, newSection)); // Now max section is 2 (3 total sections)
  
  // Clear any existing timeout
  clearTimeout(scrollTimeout);
  
  // Set a timeout to snap to the nearest section after scrolling stops
  scrollTimeout = setTimeout(() => {
    if (targetSection !== currentSection) {
      snapToSection(targetSection);
    }
  }, 150); // Small delay to allow for scroll completion
}

function handleWheel(e) {
  e.preventDefault();
  
  if (isScrolling) return;
  
  const delta = e.deltaY;
  let targetSection = currentSection;
  
  if (delta > 0 && currentSection < 2) {
    targetSection = currentSection + 1; // Scroll down to next section
  } else if (delta < 0 && currentSection > 0) {
    targetSection = currentSection - 1; // Scroll up to previous section
  }
  
  if (targetSection !== currentSection) {
    isScrolling = true;
    snapToSection(targetSection);
    
    setTimeout(() => {
      isScrolling = false;
    }, 1000); // Allow smooth scrolling and glass animation to complete
  }
}

window.addEventListener('wheel', handleWheel, { passive: false });
window.addEventListener('scroll', handleScroll, { passive: true });

// Configuration functions for scroll effects
window.setScrollRefractionMultiplier = function(multiplier) {
  scrollRefractionMultiplier = Math.max(1, multiplier || 3.0);
  if (_reedEffect) {
    setReededScrollRefractionMultiplier(_reedEffect, scrollRefractionMultiplier);
  }
  console.log(`Scroll refraction multiplier set to: ${scrollRefractionMultiplier}x`);
};

window.setHeadMovementRestriction = function(restriction) {
  headMovementRestriction = Math.max(0, Math.min(1, restriction || 0.1));
  console.log(`Head movement restriction set to: ${headMovementRestriction * 100}%`);
};

handleResize();

// add all render passes -------------------------------------------------

composer.addPass(renderScene);
composer.addPass(new EffectPass(camera, bloomEffect, hueSatEffect, brightnessContrastEffect, smaaEffect));

// Bottom vignette: init and add before reeded glass so glass overlay is not faded
{
  const created = createBottomVignettePass(camera);
  _vignetteEffect = created.effect;
  _vignettePass = created.pass;
  // Use framebuffer resolution (CSS px * effective pixel ratio) to match gl_FragCoord
  const epr = resizeRendererAndComposer._epr || computeEffectivePixelRatio();
  setBottomVignetteResolution(_vignetteEffect, Math.floor(window.innerWidth * epr), Math.floor(window.innerHeight * epr));
  composer.addPass(_vignettePass);
}

// Wire shader-only reeded refraction between grading and grain so grain overlays it
{
  const created = createReededPass(camera);
  _reedEffect = created.effect;
  _reedPass = created.pass;
  setReededResolution(_reedEffect, window.innerWidth, window.innerHeight);
  _reedPass.enabled = !!reededParams.enabled;
  composer.addPass(_reedPass);
}
composer.addPass(new EffectPass(camera, grainEffect));

// Create gradient background so it also refracts through the glass
createGradientBackground();
positionGradientBackgroundFromFrustum();

// Apply initial DPR & quality (ensures correct sizing before first frame bursts heavy effects)
_applyRendererPixelRatio();
applyEffectQuality();

function animate() {
    const delta = clock.getDelta();
  // Adaptive performance update (hybrid DPR + effect tier)
  perfAdaptiveUpdate(delta);
    
    // Update wind animation with scroll-based speed reduction
    if (mixer) {
      // Apply wind speed reduction immediately when entering section 2
      const inSecondOrThirdSection = currentScrollProgress > 1/3; // True when in section 2 or 3
      const windSpeedMultiplier = inSecondOrThirdSection ? 0.5 : 1.0; // Reduce to 50% in sections 2&3
      const effectiveWindSpeed = WIND_BASE_TS * windSpeedMultiplier;
      
      mixer.timeScale = effectiveWindSpeed;
      mixer.update(delta);   // breathing and wind
    }
    
    // Update eye intensity with scroll-based reduction
    if (eyeMeshes.length > 0) {
      // Apply eye intensity reduction only in final section (scroll progress > 0.5)
      const finalSectionProgress = Math.max(0, (currentScrollProgress - 0.5) * 2.0); // 0-1 in final section only
      const eyeIntensityMultiplier = 1.0 - (finalSectionProgress * 0.3); // Reduce to 70% when fully scrolled
      const effectiveEyeIntensity = baseEyeIntensity * eyeIntensityMultiplier;
      
      eyeMeshes.forEach(m => {
          if (m.material && m.material.emissiveIntensity !== undefined) {
            m.material.emissiveIntensity = effectiveEyeIntensity;
          }
        });
    }

  // Advance reeded time and render
  if (_reedEffect) tickReededTime(_reedEffect, delta);

  // --- Depth pass for reeded effect ---
  // Create depth RT lazily (once)
  if (!animate._depthRT) {
    const size = renderer.getSize(new THREE.Vector2());
    animate._depthRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false
    });
    animate._depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    animate._depthOverrideOld = null;
  }
  // Keep depth RT in sync with size
  {
    const size = renderer.getSize(new THREE.Vector2());
    if (animate._depthRT.width !== size.x || animate._depthRT.height !== size.y) {
      animate._depthRT.setSize(size.x, size.y);
    }
  }

  // Render scene to depth RT using override material
  const oldTarget = renderer.getRenderTarget();
  const oldAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  animate._depthOverrideOld = scene.overrideMaterial;
  scene.overrideMaterial = animate._depthMat;
  renderer.setRenderTarget(animate._depthRT);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = animate._depthOverrideOld;
  renderer.setRenderTarget(oldTarget);
  renderer.autoClear = oldAutoClear;

  // Feed depth texture to reeded shader
  if (_reedEffect) {
    setReededDepth(_reedEffect, animate._depthRT.texture, camera.near, camera.far);
  }

  // Post stack
  composer.render();

  // Update glow blobs after render state updates (use elapsed time for smooth motion)
  _updateGlowBlobs(clock.getElapsedTime());

    currentTime += 1/60;

    requestAnimationFrame(animate)
}

animate();

// Delay helper retained for a couple of non-visual holds
function delay(ms){ return new Promise(res=>setTimeout(res, ms)); }

async function startStartupSequence(){
  const tl = gsap.timeline();

  // Phase 1: fade from black to show model+bg (dark)
  tl.to(blackoutEl, { opacity: 0, duration: 1.2, ease: 'power1.inOut', onComplete: ()=>{ blackoutEl?.remove(); blackoutEl = null; } }, 0);
  tl.to(theCanvas, { opacity: 1, duration: 0.8, ease: 'power1.inOut' }, 0);
  tl.to(bgEl, { opacity: 0.1, duration: 0.6, ease: 'power1.inOut' }, 0);

  // Phase 2 setup at ~0.62s
  tl.call(() => {
    renderer.toneMappingExposure = 0.14;
    eyeMeshes.forEach(m=>{ if (m.material){ m.material.emissiveIntensity = 0.5; m.material.color.set(0x000000); }});
  }, null, 0.62);

  // Phase 3: eyes on after 1s
  tl.add('eyesOn', 1.62);
  eyeMeshes.forEach(m=>{
    // Adjust target eye intensity based on scroll position
    const baseTargetEI = 6; 
    const scrollAdjustedEI = baseTargetEI * (1.0 - (currentScrollProgress * 0.5)); // Apply scroll reduction if needed
    const targetEI = scrollAdjustedEI;
    
    const orig = (m.userData.eyeOriginalColor && m.userData.eyeOriginalColor.isColor) ? m.userData.eyeOriginalColor : new THREE.Color('#2C2C2C');
    tl.to(m.material, { emissiveIntensity: targetEI, duration: 0.12, ease: 'power1.out' }, 'eyesOn');
    tl.to(m.material.color, { r: orig.r, g: orig.g, b: orig.b, duration: 0.12, ease: 'none' }, 'eyesOn');
  });

  // Match lights intensity ramp to eyes-on: 10% -> 100% over the same window
  allLights.forEach(l => {
    const finalI = lightFinalIntensities.get(l) ?? l.intensity;
    tl.to(l, { intensity: finalI, duration: 0.4, ease: 'power1.out' }, 'eyesOn');
  });

  // Phase 4: exposure/background 800ms after eyes
  tl.add('phase4', 'eyesOn+=0.8');
  // Calculate the correct target exposure based on current scroll position
  const startupTargetExposure = currentScrollProgress > 0.5 ? baseExposure * 0.7 : baseExposure;
  tl.to(renderer, { toneMappingExposure: startupTargetExposure, duration: 1.6, ease: 'power1.inOut' }, 'phase4');
  tl.to(bgEl, { opacity: 0.75, duration: 1.8, ease: 'power1.inOut' }, 'phase4');

  // Phase 5: chin settle 100ms after Phase 4 starts
  if (chin) {
  // Sync camera zoom-out with chin settling to rest
  tl.to(chin.rotation, { x: Math.PI/2, duration: 1.2, ease: 'power1.inOut' }, 'phase4+=0.1');
  tl.to(camera, { zoom: 1.0, duration: 1.5, ease: 'power3.inOut', onUpdate: ()=> camera.updateProjectionMatrix() }, 'phase4+=0.1');
  }

  // Mark startup complete when timeline ends
  await new Promise(res => tl.eventCallback('onComplete', () => res()));
  startupActive = false;

  // Apply scroll-based wind speed if we're in the final section
  if (mixer && currentScrollProgress > 0.5) {
    const finalSectionProgress = (currentScrollProgress - 0.5) * 2.0; // 0-1 in final section only
    const windSpeedMultiplier = 1.0 - (finalSectionProgress * 0.5);
    mixer.timeScale = WIND_BASE_TS * windSpeedMultiplier;
  }

  // Enable head look 0.1s after startup ends, then start breathing
  await delay(10);
  if (!IS_TOUCH_DEVICE) {
    allowHeadLook = true;
    if (chin) startHeadLook(chin);
  } else {
    allowHeadLook = false;
    // Keep head centered and run only breathing updates on touch devices
    startBreathingOnly();
  }
  _shoulderStartMs = Date.now();
  _chinBreathActive = false;
  _chinGain = 0;
  _chinStartMs = null;
  allowBreathing = true;
}
