/**
 * Velocity-aware snap scrolling system with glass shader transitions
 */

import { gsap } from 'gsap';

export class ScrollSystem {
    constructor(options = {}) {
        this.container = options.container || document.getElementById('scroll-container');
        this.panels = [...this.container.querySelectorAll('.panel')];
        this.currentSection = 0;
        this.totalSections = this.panels.length;
        
        // Scroll behavior config
        this.wheelAccumulator = 0;
        this.wheelTimeout = null;
        this.isAnimating = false;
        this.inputLocked = false;
        
        // Thresholds and timing
        this.mouseThreshold = 120;      // pixels for mouse wheel
        this.trackpadThreshold = 90;    // pixels for trackpad
        this.skipThreshold = 600;       // pixels to skip sections
        this.accumTime = 250;           // ms to accumulate wheel deltas
        this.animDuration = 500;        // ms for snap animation
        this.inputLockTime = 300;       // ms to lock input after snap
        
        // Callbacks for glass shader updates
        this.onSectionChange = options.onSectionChange || (() => {});
        this.onProgress = options.onProgress || (() => {});
        
        // Check for reduced motion preference
        this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        
        this.init();
    }
    
    init() {
        if (this.prefersReducedMotion) {
            this.initReducedMotion();
            return;
        }
        
        this.setupEventListeners();
        this.updatePosition(0); // Start at hero
    }
    
    initReducedMotion() {
        // For reduced motion, use CSS scroll-snap and instant transitions
        this.container.style.overflowY = 'auto';
        this.container.style.scrollSnapType = 'y mandatory';
        this.panels.forEach(panel => {
            panel.style.scrollSnapAlign = 'start';
        });
        
        // Set glass shader to final state instantly based on scroll position
        this.container.addEventListener('scroll', () => {
            const scrollTop = this.container.scrollTop;
            const sectionHeight = window.innerHeight;
            const section = Math.round(scrollTop / sectionHeight);
            const progress = (scrollTop % sectionHeight) / sectionHeight;
            
            this.currentSection = Math.max(0, Math.min(section, this.totalSections - 1));
            
            // Instant shader updates for reduced motion
            this.onSectionChange(this.currentSection);
            if (this.currentSection === 1) {
                this.onProgress(1); // Full glass effect for about section
            } else {
                this.onProgress(0); // No glass effect for hero
            }
        });
    }
    
    setupEventListeners() {
        // Wheel events
        this.container.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
        
        // Keyboard events
        document.addEventListener('keydown', this.handleKeyboard.bind(this));
        
        // Touch events for mobile
        this.setupTouchEvents();
        
        // Resize handler
        window.addEventListener('resize', this.handleResize.bind(this));
    }
    
    handleWheel(e) {
        if (this.isAnimating || this.inputLocked || this.prefersReducedMotion) return;
        
        e.preventDefault();
        
        // Detect wheel type (mouse vs trackpad) based on delta magnitude
        const isDeltaLarge = Math.abs(e.deltaY) > 40;
        const threshold = isDeltaLarge ? this.mouseThreshold : this.trackpadThreshold;
        
        // Accumulate wheel deltas
        this.wheelAccumulator += e.deltaY;
        
        // Clear existing timeout and set new one
        clearTimeout(this.wheelTimeout);
        this.wheelTimeout = setTimeout(() => {
            this.wheelAccumulator = 0;
        }, this.accumTime);
        
        // Check if we've exceeded threshold
        const absAccum = Math.abs(this.wheelAccumulator);
        if (absAccum >= threshold) {
            const direction = this.wheelAccumulator > 0 ? 1 : -1;
            
            // Check for skip behavior
            let sectionsToMove = 1;
            if (absAccum >= this.skipThreshold) {
                sectionsToMove = 2;
            }
            
            this.navigateToSection(this.currentSection + (direction * sectionsToMove));
            this.wheelAccumulator = 0;
            clearTimeout(this.wheelTimeout);
        }
    }
    
    handleKeyboard(e) {
        if (this.isAnimating || this.inputLocked || this.prefersReducedMotion) return;
        
        switch(e.key) {
            case 'PageDown':
            case 'ArrowDown':
            case ' ':
                e.preventDefault();
                this.navigateToSection(this.currentSection + 1);
                break;
            case 'PageUp':
            case 'ArrowUp':
                e.preventDefault();
                this.navigateToSection(this.currentSection - 1);
                break;
            case 'Home':
                e.preventDefault();
                this.navigateToSection(0);
                break;
            case 'End':
                e.preventDefault();
                this.navigateToSection(this.totalSections - 1);
                break;
        }
    }
    
    setupTouchEvents() {
        let startY = 0;
        let startTime = 0;
        
        this.container.addEventListener('touchstart', (e) => {
            if (this.prefersReducedMotion) return;
            startY = e.touches[0].clientY;
            startTime = Date.now();
        }, { passive: true });
        
        this.container.addEventListener('touchend', (e) => {
            if (this.isAnimating || this.inputLocked || this.prefersReducedMotion) return;
            
            const endY = e.changedTouches[0].clientY;
            const endTime = Date.now();
            const deltaY = startY - endY;
            const deltaTime = endTime - startTime;
            
            // Only process swipes that are fast enough and long enough
            if (deltaTime < 300 && Math.abs(deltaY) > 50) {
                const direction = deltaY > 0 ? 1 : -1;
                this.navigateToSection(this.currentSection + direction);
            }
        }, { passive: true });
    }
    
    navigateToSection(targetSection) {
        // Clamp to valid range
        targetSection = Math.max(0, Math.min(targetSection, this.totalSections - 1));
        
        if (targetSection === this.currentSection) return;
        
        this.isAnimating = true;
        
        const startSection = this.currentSection;
        this.currentSection = targetSection;
        
        // Notify about section change
        this.onSectionChange(this.currentSection);
        
        // Animate scroll position with progress callbacks
        gsap.to(this, {
            duration: this.animDuration / 1000,
            ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
            scrollProgress: 1,
            onStart: () => {
                this.scrollProgress = 0;
            },
            onUpdate: () => {
                const progress = this.scrollProgress;
                const currentPos = startSection + (targetSection - startSection) * progress;
                this.updatePosition(currentPos);
                
                // Calculate glass shader progress (0 = hero, 1 = about)
                let glassProgress = 0;
                if (targetSection === 1) {
                    // Going to or on about section
                    glassProgress = Math.max(0, currentPos);
                } else if (startSection === 1) {
                    // Coming from about section
                    glassProgress = Math.max(0, currentPos);
                }
                
                this.onProgress(Math.min(1, Math.max(0, glassProgress)));
            },
            onComplete: () => {
                this.isAnimating = false;
                this.updatePosition(targetSection);
                
                // Lock input briefly to prevent double snaps
                this.inputLocked = true;
                setTimeout(() => {
                    this.inputLocked = false;
                }, this.inputLockTime);
            }
        });
    }
    
    updatePosition(section) {
        const translateY = -section * 100;
        this.container.style.transform = `translateY(${translateY}vh)`;
    }
    
    handleResize() {
        // Recalculate positions on resize
        this.updatePosition(this.currentSection);
    }
    
    // Public API
    getCurrentSection() {
        return this.currentSection;
    }
    
    goToSection(section) {
        this.navigateToSection(section);
    }
    
    destroy() {
        clearTimeout(this.wheelTimeout);
        // Remove event listeners
        this.container.removeEventListener('wheel', this.handleWheel);
        document.removeEventListener('keydown', this.handleKeyboard);
        window.removeEventListener('resize', this.handleResize);
    }
}
