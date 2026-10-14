// The motion layer.
//
// Every animation in the product goes through this file, so the timing stays
// consistent, `prefers-reduced-motion` is honoured in one place, and a missing
// animation library degrades to a CSS transition instead of a broken screen.
//
//   · DOM choreography (reveals, staggered entrances) → anime.js (vendored)
//   · number tweens (score ring)                      → requestAnimationFrame
//   · module switches                                 → View Transitions API
//   · press/hover feedback                            → CSS (see styles.css)
(function (root, factory) {
  const motion = factory();
  if (typeof module === "object" && module.exports) module.exports = motion;
  root.AnswerLensMotion = motion;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // One table for every animated scenario: this is the single source of truth
  // for how long a transition takes and how far an element travels.
  const SPEC = {
    tab: { kind: "swap", duration: 320, easing: "outCubic" },
    section: { kind: "reveal", duration: 460, easing: "outCubic", y: 22 },
    panel: { kind: "reveal", duration: 320, easing: "outCubic", y: 14 },
    sidebar: { kind: "reveal", duration: 260, easing: "outCubic", x: -12 },
    blocks: { kind: "stagger", duration: 420, easing: "outCubic", y: 16, stagger: 55 },
    cards: { kind: "stagger", duration: 340, easing: "outCubic", y: 10, stagger: 45 },
    timeline: { kind: "stagger", duration: 320, easing: "outCubic", y: 10, stagger: 60 },
    message: { kind: "reveal", duration: 280, easing: "outCubic", y: 10 },
    breakdown: { kind: "reveal", duration: 260, easing: "outCubic", y: -6 },
    score: { kind: "count", duration: 900, easing: "outCubic" }
  };

  const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const state = {
    ready: false,
    reduced: false,
    engine: "none",
    // Every animation reserves the time it needs, so `whenIdle()` can wait for
    // the screen to settle without tracking individual timelines.
    busyUntil: 0
  };

  function readReduced(matchMediaImpl) {
    if (typeof matchMediaImpl !== "function") return false;
    try {
      return Boolean(matchMediaImpl("(prefers-reduced-motion: reduce)").matches);
    } catch {
      return false;
    }
  }

  function prefersReducedMotion(matchMediaImpl) {
    if (matchMediaImpl) return readReduced(matchMediaImpl);
    if (!hasDom || typeof window.matchMedia !== "function") return false;
    return readReduced(window.matchMedia.bind(window));
  }

  function detectEngine(globals) {
    const scope = globals || {};
    if (scope.anime && typeof scope.anime.animate === "function") return "anime";
    return "none";
  }

  // Turns a scenario into the timing actually used on this machine.
  function plan(scenario, options) {
    const name = Object.prototype.hasOwnProperty.call(SPEC, scenario) ? scenario : "section";
    const spec = SPEC[name];
    const opts = options || {};
    const reduced = opts.reduced === undefined ? state.reduced : Boolean(opts.reduced);
    const engine = opts.engine === undefined ? state.engine : opts.engine;
    const skip = reduced || engine === "none";
    return {
      scenario: name,
      kind: spec.kind,
      skip,
      engine,
      duration: skip ? 0 : spec.duration,
      stagger: skip ? 0 : spec.stagger || 0,
      easing: spec.easing,
      y: spec.y || 0,
      x: spec.x || 0
    };
  }

  function init() {
    if (!hasDom) {
      state.ready = true;
      return config();
    }
    state.reduced = prefersReducedMotion();
    state.engine = detectEngine(window);
    if (typeof window.matchMedia === "function") {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const sync = () => {
        state.reduced = Boolean(query.matches);
        document.documentElement.dataset.motion = motionIsOn() ? "on" : "off";
      };
      if (typeof query.addEventListener === "function") query.addEventListener("change", sync);
      else if (typeof query.addListener === "function") query.addListener(sync);
    }
    document.documentElement.dataset.motion = motionIsOn() ? "on" : "off";
    state.ready = true;
    return config();
  }

  function motionIsOn() {
    return state.engine === "anime" && !state.reduced;
  }

  function config() {
    return {
      ready: state.ready,
      reduced: state.reduced,
      engine: state.engine,
      active: motionIsOn()
    };
  }

  function markBusy(ms) {
    if (!hasDom) return;
    state.busyUntil = Math.max(state.busyUntil, performance.now() + Math.max(0, ms));
  }

  // Resolves once nothing is animating any more. Tests use it to measure the
  // settled layout instead of a frame in the middle of a transition.
  function whenIdle() {
    if (!hasDom) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (performance.now() >= state.busyUntil) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  function clearMotion(el) {
    if (!el || !el.classList) return;
    el.classList.remove("motion-enter", "is-motion-in");
    el.style.removeProperty("opacity");
    el.style.removeProperty("transform");
    el.style.removeProperty("--motion-dur");
    el.style.removeProperty("--motion-from");
    el.style.removeProperty("--motion-delay");
  }

  function cancelPendingHide(el) {
    if (el && el.__motionHideTimer) {
      clearTimeout(el.__motionHideTimer);
      el.__motionHideTimer = null;
    }
  }

  // What the control *intends* to be, which is what a toggle must read: during
  // an exit animation the element is still visible, so `hidden` lies.
  function isOpen(el) {
    if (!el) return false;
    if (typeof el.__motionOpen === "boolean") return el.__motionOpen;
    return !el.hidden;
  }

  function animeParams(plan, extra) {
    const params = {
      opacity: [0, 1],
      y: [plan.y, 0],
      duration: plan.duration,
      ease: plan.easing
    };
    if (plan.x) params.x = [plan.x, 0];
    return Object.assign(params, extra || {});
  }

  function reveal(el, scenario) {
    if (!el) return;
    cancelPendingHide(el);
    el.__motionOpen = true;
    el.hidden = false;
    const planned = plan(scenario);
    if (planned.skip) {
      clearMotion(el);
      return;
    }
    if (planned.engine === "anime") {
      markBusy(planned.duration + 40);
      window.anime.animate(
        el,
        animeParams(planned, {
          onComplete: () => clearMotion(el)
        })
      );
      return;
    }
    // No library: the same motion through a CSS transition.
    el.classList.add("motion-enter");
    el.style.setProperty("--motion-dur", `${planned.duration}ms`);
    el.style.setProperty("--motion-from", planned.x ? `translateX(${planned.x}px)` : `translateY(${planned.y}px)`);
    el.classList.add("is-motion-in");
    markBusy(planned.duration + 60);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.classList.remove("is-motion-in");
        setTimeout(() => clearMotion(el), planned.duration + 80);
      })
    );
  }

  function hide(el, scenario) {
    if (!el) return;
    el.__motionOpen = false;
    if (el.hidden) return;
    const planned = plan(scenario);
    if (planned.skip || planned.engine !== "anime") {
      el.hidden = true;
      clearMotion(el);
      return;
    }
    const duration = Math.round(planned.duration * 0.78);
    markBusy(duration + 40);
    const finish = () => {
      cancelPendingHide(el);
      el.hidden = true;
      clearMotion(el);
    };
    // A safety net: if the animation never reports back, the panel still closes.
    el.__motionHideTimer = setTimeout(finish, duration + 260);
    window.anime.animate(el, {
      opacity: [1, 0],
      y: [0, planned.y || 8],
      duration,
      ease: "inQuad",
      onComplete: finish
    });
  }

  function stagger(container, selector, scenario) {
    if (!container || !selector) return;
    const nodes = Array.prototype.slice.call(container.querySelectorAll(selector));
    if (!nodes.length) return;
    const planned = plan(scenario);
    if (planned.skip) {
      nodes.forEach(clearMotion);
      return;
    }
    const total = planned.duration + planned.stagger * Math.max(0, nodes.length - 1);
    markBusy(total + 60);
    if (planned.engine === "anime") {
      window.anime.animate(
        nodes,
        animeParams(planned, {
          delay: window.anime.stagger(planned.stagger),
          onComplete: () => nodes.forEach(clearMotion)
        })
      );
      return;
    }
    nodes.forEach((node, index) => {
      node.classList.add("motion-enter");
      node.style.setProperty("--motion-dur", `${planned.duration}ms`);
      node.style.setProperty("--motion-from", `translateY(${planned.y}px)`);
      node.style.setProperty("--motion-delay", `${index * planned.stagger}ms`);
      node.classList.add("is-motion-in");
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("is-motion-in")));
    });
    setTimeout(() => nodes.forEach(clearMotion), total + 120);
  }

  // Numbers can't be handed to a DOM animator, so they run on rAF. Both the
  // ring and the number are driven by one tween so they can never drift apart.
  function tween(from, to, scenario, onUpdate, onDone) {
    if (typeof onUpdate !== "function") return;
    const planned = plan(scenario);
    const startValue = Number(from) || 0;
    const endValue = Number(to) || 0;
    if (planned.skip) {
      onUpdate(endValue);
      if (onDone) onDone();
      return;
    }
    markBusy(planned.duration + 40);
    const started = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / planned.duration);
      onUpdate(startValue + (endValue - startValue) * easeOutCubic(progress));
      if (progress < 1) requestAnimationFrame(step);
      else if (onDone) onDone();
    };
    requestAnimationFrame(step);
  }

  function countUp(el, from, to, scenario, format) {
    if (!el) return;
    const render = typeof format === "function" ? format : (value) => String(Math.round(value));
    tween(from, to, scenario, (value) => {
      el.textContent = render(value);
    });
  }

  // The bars are already laid out at their final width so they are correct even
  // if nothing animates; this rewinds them and lets CSS transition them back.
  function playBars(container, delayStep) {
    if (!container) return;
    const fills = Array.prototype.slice.call(container.querySelectorAll(".bar-fill[data-value]"));
    if (!fills.length) return;
    const planned = plan("blocks");
    if (planned.skip) return;
    const gap = delayStep === undefined ? 70 : delayStep;
    fills.forEach((fill) => fill.style.setProperty("--value", "0%"));
    markBusy(900 + gap * fills.length);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fills.forEach((fill, index) => {
          fill.style.transitionDelay = `${index * gap}ms`;
          fill.style.setProperty("--value", fill.dataset.value);
        });
      })
    );
  }

  // Module switches: the browser snapshots the old and new DOM, so panels can
  // cross-fade even though the swap itself is a `display` change.
  function swap(mutate) {
    if (typeof mutate !== "function") return Promise.resolve();
    const planned = plan("tab");
    if (planned.skip || !hasDom || typeof document.startViewTransition !== "function") {
      mutate();
      return Promise.resolve();
    }
    try {
      const transition = document.startViewTransition(mutate);
      markBusy(planned.duration + 60);
      if (transition && transition.finished) return transition.finished.catch(() => {});
      return Promise.resolve();
    } catch {
      mutate();
      return Promise.resolve();
    }
  }

  return {
    SPEC,
    init,
    config,
    plan,
    detectEngine,
    prefersReducedMotion,
    whenIdle,
    isOpen,
    reveal,
    hide,
    stagger,
    tween,
    countUp,
    playBars,
    swap
  };
});
