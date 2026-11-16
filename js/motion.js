/* Helium: interruptible spring physics (stiffness 380, damping 32, mass 1 by default). */
(function (H) {
  'use strict';

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = { get reduced() { return mq.matches; } };

  class Spring {
    constructor({ value = 0, stiffness = 380, damping = 32, mass = 1, precision = 0.0008, onUpdate, onRest } = {}) {
      Object.assign(this, { value, target: value, velocity: 0, stiffness, damping, mass, precision, onUpdate, onRest });
      this.raf = 0;
      this.last = 0;
      this.step = this.step.bind(this);
    }

    get running() { return this.raf !== 0; }

    // Jump without animation (used while a finger is dragging).
    set(value) {
      this.stop();
      this.value = this.target = value;
      this.velocity = 0;
      this.onUpdate && this.onUpdate(value);
    }

    // Animate towards target. A running animation is re-targeted, keeping its velocity (interruptible).
    to(target, { velocity } = {}) {
      this.target = target;
      if (velocity !== undefined) this.velocity = velocity;
      if (motion.reduced) {
        this.set(target);
        this.onRest && this.onRest(target);
        return;
      }
      if (!this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.step);
      }
    }

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    step(now) {
      let dt = Math.min(0.064, (now - this.last) / 1000);
      this.last = now;
      const h = 1 / 240; // fixed sub-step for stability
      while (dt > 0) {
        const s = Math.min(h, dt);
        const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
        this.velocity += (force / this.mass) * s;
        this.value += this.velocity * s;
        dt -= s;
      }
      if (Math.abs(this.velocity) < this.precision * 20 && Math.abs(this.value - this.target) < this.precision) {
        this.value = this.target;
        this.velocity = 0;
        this.raf = 0;
        this.onUpdate && this.onUpdate(this.value);
        this.onRest && this.onRest(this.value);
        return;
      }
      this.onUpdate && this.onUpdate(this.value);
      this.raf = requestAnimationFrame(this.step);
    }
  }

  H.motion = motion;
  H.Spring = Spring;
})(window.Helium = window.Helium || {});
