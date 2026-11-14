import fs from "node:fs";
import path from "node:path";
import { countViewTransitions, motionContext, runningAnimations, settle, viewTransitionCalls } from "./tools/motion-harness.mjs";

export const QUICK = 80;
export const STANDARD = 160;
export const SCREEN = 240;

const SPEEDS = [QUICK, STANDARD, SCREEN];
const META = ["offset", "computedOffset", "easing", "composite"];

const same = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(what + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

export const frames = (p, count = 2) => p.evaluate((left) => new Promise((done) => { const step = () => (--left > 0 ? requestAnimationFrame(step) : done()); requestAnimationFrame(step); }), count);

export const moveOf = (p) => p.evaluate(() => document.documentElement.dataset.move ?? null);

export const pseudos = (running) => running.map((one) => one.pseudo).filter(Boolean).sort();

export const animationsOf = (locator) =>
  locator.evaluateAll(
    (elements, meta) =>
      elements.flatMap((element) =>
        element.getAnimations({ subtree: true }).filter((one) => !one.effect.target?.closest?.("[data-progress]")).map((one) => ({
          duration: one.effect.getComputedTiming().duration,
          properties: [...new Set(one.effect.getKeyframes().flatMap((frame) => Object.keys(frame).filter((key) => !meta.includes(key))))].sort(),
        })),
      ),
    META,
  );

export const watchBlank = (p) =>
  p.evaluate(() => {
    window.__qdBlank = false;
    const look = () => {
      const sliding = document.getAnimations().some((one) => one.effect?.pseudoElement?.startsWith("::view-transition"));
      if (sliding && document.querySelector("[data-motion-wait]")) window.__qdBlank = true;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });

export const blankSeen = (p) => p.evaluate(() => window.__qdBlank === true);

export const motionReady = (page) => page.waitForFunction(() => document.querySelector('link[href$="motion.css"]')?.sheet);

const otherLook = () => {
  const root = document.documentElement;
  const was = root.getAttribute("data-appearance");
  root.setAttribute("data-appearance", was === "light" ? "dark" : "light");
  return was;
};

const lookBack = (was) => {
  const root = document.documentElement;
  if (was === null) root.removeAttribute("data-appearance");
  else root.setAttribute("data-appearance", was);
};

async function redrawPaneLayers(page) {
  const was = await page.evaluate(otherLook);
  await frames(page);
  await settle(page);
  await page.evaluate(lookBack, was);
  await frames(page);
  await settle(page);
  await frames(page);
}

const leaveStyle = (selector) => document.querySelector(selector).style.setProperty("opacity", "0.98");

async function motionRun(browser, { size, still, steps, prepare, ignore, late, leftover }) {
  const options = { colorScheme: "dark", ...size };
  const context = still ? await browser.newContext({ ...options, reducedMotion: "reduce" }) : await motionContext(browser, options);
  await countViewTransitions(context);
  if (prepare) await prepare(context);
  if (late === "held") await context.route((url) => url.pathname.endsWith("/motion.css"), () => {});
  const page = await context.newPage();
  if (late !== "held") {
    const goto = page.goto.bind(page);
    page.goto = async (...args) => {
      const response = await goto(...args);
      await motionReady(page);
      return response;
    };
  }
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => message.type() === "error" && !ignore?.(message) && errors.push(message.text()));
  const m = {
    still,
    hold: async () => {
      if (still) return async () => {};
      const cdp = await context.newCDPSession(page);
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
      return async () => {
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
        await cdp.detach();
        await page.waitForFunction(() => document.documentElement.dataset.move === undefined, null, { polling: "raf" });
      };
    },
    during: async (what, where, check) => {
      if (still) {
        await frames(page);
        same(await runningAnimations(page), [], what + ", with Reduce Motion on: nothing moves");
        return;
      }
      try {
        await page.waitForFunction(
          (where) => document.getAnimations().some((one) => ["running", "pending"].includes(one.playState) && (where === "view-transition" ? one.effect?.pseudoElement?.startsWith("::view-transition") : one.effect?.target?.closest?.(where))),
          where,
          { polling: "raf" },
        );
      } catch {
        throw new Error(what + ": nothing started moving at " + where);
      }
      const running = await runningAnimations(page);
      same(running.filter((one) => !SPEEDS.includes(one.duration) || one.delay !== 0 || one.iterations !== 1), [], what + ": every motion runs once, starts at once and takes a theme speed");
      if (check) await check(running);
    },
  };
  try {
    await steps(page, m);
    await settle(page);
    same(
      await page.evaluate(() => [document.documentElement.dataset.move ?? null, document.querySelectorAll("[data-leaving]").length, document.getAnimations().length]),
      [null, 0, 0],
      (still ? "with Reduce Motion" : "with motion") + ": once it settles nothing is marked, copied or held part way",
    );
    if (errors.length) throw new Error("console errors: " + errors.join(" | "));
    if (leftover && !still) {
      await page.evaluate(leaveStyle, leftover);
      await settle(page);
    }
    await page.evaluate(() => document.body.style.setProperty("will-change", "opacity"));
    await frames(page);
    await redrawPaneLayers(page);
    return { picture: await page.screenshot(), starts: await viewTransitionCalls(page) };
  } finally {
    await context.close();
  }
}

function pixelsApart([a, b]) {
  const load = (data) =>
    new Promise((done) => {
      const image = new Image();
      image.onload = () => done(image);
      image.src = "data:image/png;base64," + data;
    });
  const read = (image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  return Promise.all([load(a), load(b)]).then(([one, two]) => {
    if (one.width !== two.width || one.height !== two.height) return "the sizes differ";
    const [x, y] = [read(one), read(two)];
    const spots = [];
    let count = 0;
    for (let at = 0; at < x.length; at += 4) {
      if (x[at] === y[at] && x[at + 1] === y[at + 1] && x[at + 2] === y[at + 2]) continue;
      count += 1;
      if (spots.length < 6) spots.push((at / 4) % one.width + "," + Math.floor(at / 4 / one.width) + " " + [x[at], x[at + 1], x[at + 2]].join("/") + " vs " + [y[at], y[at + 1], y[at + 2]].join("/"));
    }
    return count + " pixels differ, first at " + spots.join("; ");
  });
}

let kept = 0;

function keepPictures(size, moving, still) {
  const folder = process.env.QD_MOTION_SHOTS;
  if (!folder) return "";
  fs.mkdirSync(folder, { recursive: true });
  const stem = path.join(folder, process.pid + "-" + ++kept + "-" + (size.viewport ? size.viewport.width + "x" + size.viewport.height : "page"));
  fs.writeFileSync(stem + "-motion.png", moving);
  fs.writeFileSync(stem + "-reduce.png", still);
  return "; both pictures are kept as " + stem + "-motion.png and " + stem + "-reduce.png";
}

export async function motionPair(p, size, steps, extra = {}) {
  const browser = p.context().browser();
  const moving = await motionRun(browser, { size, still: false, steps, ...extra });
  const still = await motionRun(browser, { size, still: true, steps, ...extra });
  same(still.starts, 0, "with Reduce Motion no view transition starts");
  if (moving.picture.equals(still.picture)) return;
  const where = extra.leftover ? "" : keepPictures(size, moving.picture, still.picture);
  const page = await browser.newPage();
  try {
    throw new Error("the end picture with motion differs from the Reduce Motion picture: " + (await page.evaluate(pixelsApart, [moving.picture.toString("base64"), still.picture.toString("base64")])) + where);
  } finally {
    await page.close();
  }
}

export { settle, runningAnimations, viewTransitionCalls };
