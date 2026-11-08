export const motionContext = (browser, options = {}) => browser.newContext({ ...options, reducedMotion: "no-preference" });

function installCounter(options, scope = globalThis) {
  const record = { starts: 0 };
  scope.__qdMotion = record;
  const original = scope.document.startViewTransition;
  if (typeof original !== "function") return;
  scope.document.startViewTransition = function (...args) {
    record.starts += 1;
    return original.apply(scope.document, args);
  };
}

function readStarts(options, scope = globalThis) {
  return scope.__qdMotion?.starts ?? 0;
}

function listAnimations(options, scope = globalThis) {
  const live = new Set(["running", "pending"]);
  const meta = new Set(["offset", "computedOffset", "easing", "composite"]);
  const nameOf = (target) => target.tagName.toLowerCase() + (target.id ? "#" + target.id : "") + (target.getAttribute("data-testid") ? "[data-testid=\"" + target.getAttribute("data-testid") + "\"]" : "");
  return scope.document
    .getAnimations()
    .filter((one) => live.has(one.playState) && !one.effect?.target?.closest?.("[data-progress]"))
    .map((one) => {
      const effect = one.effect;
      const timing = effect.getComputedTiming();
      return {
        kind: one.constructor.name,
        name: one.animationName ?? one.transitionProperty ?? null,
        target: nameOf(effect.target),
        pseudo: effect.pseudoElement ?? null,
        properties: [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame).filter((key) => !meta.has(key))))].sort(),
        duration: Number.isFinite(timing.duration) ? timing.duration : null,
        delay: timing.delay,
        iterations: timing.iterations,
        easing: effect.getTiming().easing,
        playState: one.playState,
      };
    });
}

async function settleAnimations(options, scope = globalThis) {
  const limit = options?.rounds ?? 20;
  const live = new Set(["running", "pending"]);
  for (let round = 0; round < limit; round += 1) {
    const running = scope.document.getAnimations().filter((one) => live.has(one.playState) && !one.effect?.target?.closest?.("[data-progress]"));
    if (!running.length) return round;
    const endless = running.find((one) => one.effect.getComputedTiming().iterations === Infinity);
    if (endless) throw new Error("endless animation: " + (endless.animationName ?? endless.transitionProperty ?? "unnamed"));
    await Promise.allSettled(running.map((one) => one.finished));
    await new Promise((done) => scope.requestAnimationFrame(done));
  }
  throw new Error("motion did not settle after " + limit + " rounds");
}

export const countViewTransitions = (context) => context.addInitScript(installCounter);

export const viewTransitionCalls = (page) => page.evaluate(readStarts);

export const runningAnimations = (page) => page.evaluate(listAnimations);

export const settle = (page, options = {}) => page.evaluate(settleAnimations, options);
