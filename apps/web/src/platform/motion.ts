export type Way = "forward" | "back" | "fade";
export type Move = { scope: "screen" | "pane"; way: Way };
export type ScreenChange = "fade-slide" | "fade";
export type View = { wide: boolean; panes: number } | null;
export type Shown<T> = { id: string; item: T; fresh: boolean; leaving: boolean };

type Transition = { finished: Promise<unknown>; ready: Promise<unknown>; skipTransition: () => void };
type Screen = Pick<Document, "documentElement" | "body" | "querySelector" | "querySelectorAll" | "getAnimations"> & {
  startViewTransition?: (update: () => Promise<void>) => Transition;
};

export const SCREEN_CHANGE: ScreenChange = "fade-slide";

const WAIT = "[data-motion-wait]";
const ARRIVING = "screen-arrive";
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const partsOf = (path: string) => path.split(/[?#]/)[0].split("/").filter(Boolean);

let active: Transition | null = null;

export function viewNow(doc: Screen = document): View {
  if (!doc.querySelector("#main-scroll")) return null;
  const mode = doc.querySelector<HTMLElement>("#stage")?.dataset.mode;
  return { wide: mode === "mac" || mode === "sideways", panes: doc.querySelectorAll("[data-pane]").length };
}

export function moveFor(from: string, to: string, view: View, change: ScreenChange = SCREEN_CHANGE): Move | null {
  const was = partsOf(from);
  const now = partsOf(to);
  if (!view || was.join("/") === now.join("/")) return null;
  const same = was[0] === now[0];
  return {
    scope: view.wide && same && view.panes === 1 ? "pane" : "screen",
    way: !same || change === "fade" ? "fade" : now.length < was.length ? "back" : "forward",
  };
}

export function changeScreen(update: () => void, move: Move | null, doc: Screen = document, reduce = reducedMotion, tick = nextTask): void {
  if (!move || !doc.startViewTransition || reduce()) {
    update();
    return;
  }
  const root = doc.documentElement;
  const mark = move.scope + " " + move.way;
  root.dataset.move = mark;
  const change = doc.startViewTransition(async () => {
    update();
    await tick();
    if (doc.querySelector(WAIT)) change.skipTransition();
    else if (active === change) root.dataset.move = mark + " live";
  });
  active = change;
  const done = async () => {
    const arriving = doc.getAnimations().filter((one) => (one as CSSAnimation).animationName === ARRIVING);
    await Promise.all(arriving.map((one) => one.finished.catch(() => undefined)));
    if (active !== change) return;
    active = null;
    delete root.dataset.move;
  };
  change.ready.catch(() => undefined);
  change.finished.then(done, done);
}

export function moveScreen(update: () => void, from: string, to: string): void {
  changeScreen(update, moveFor(from, to, viewNow(), __QD_PREVIEW__ && new URLSearchParams(location.search).get("motion") === "fade" ? "fade" : SCREEN_CHANGE));
}

export function stillScreen(): void {
  active?.skipTransition();
}

function foldFrom(row: HTMLElement | null): void {
  if (!row) return;
  row.style.setProperty("--fold-h", row.offsetHeight + "px");
  const gap = row.parentElement ? getComputedStyle(row.parentElement).rowGap : "";
  if (gap.endsWith("px")) row.style.setProperty("--fold-gap", "-" + gap);
}

export type RowMotion = { "data-row": "in" | "out"; ref?: (row: HTMLElement | null) => void; inert?: boolean; "aria-hidden"?: boolean; onAnimationEnd?: (event: { target: EventTarget; currentTarget: EventTarget }) => void };

export function rowMotion({ id, fresh, leaving }: { id: string; fresh: boolean; leaving: boolean }, drop: (id: string) => void): RowMotion | undefined {
  if (leaving) return { "data-row": "out", ref: foldFrom, inert: true, "aria-hidden": true, onAnimationEnd: (event) => event.target === event.currentTarget && drop(id) };
  return fresh ? { "data-row": "in" } : undefined;
}

export type Last<T> = { reset: string; shown: Shown<T>[] } | null;

export function shownNow<T>(last: Last<T>, items: readonly T[], idOf: (item: T) => string, reset: string, tailOnly: boolean): Shown<T>[] {
  const merged = mergeShown(last?.reset === reset && !reducedMotion() ? last.shown : null, items, idOf, tailOnly);
  return tailOnly ? merged.filter((entry) => !entry.leaving) : merged;
}

export function dropFrom<T>(last: { current: Last<T> }, id: string, redraw: () => void): void {
  if (!last.current) return;
  last.current = { ...last.current, shown: dropShown(last.current.shown, id) };
  redraw();
}

let sheet: HTMLLinkElement | undefined;

export function start(): void {
  sheet = document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: (__QD_PREVIEW__ ? "" : "/") + "motion.css" }));
}

export const ready = () => Boolean(sheet?.sheet);

export function leaveCopy(node: Element | null, doc: Screen = document, reduce = reducedMotion): void {
  if (!node?.isConnected || reduce() || doc.documentElement.dataset.move !== undefined) return;
  const box = node.getBoundingClientRect();
  const copy = node.cloneNode(true) as HTMLElement;
  for (const part of [copy, ...copy.querySelectorAll("[id],[data-testid]")]) {
    part.removeAttribute("id");
    part.removeAttribute("data-testid");
  }
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  copy.dataset.leaving = "";
  copy.classList.add("leave");
  Object.assign(copy.style, { position: "fixed", left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px", margin: "0px", pointerEvents: "none" });
  const end = (event: Event) => {
    if (event.target === copy) copy.remove();
  };
  copy.addEventListener("animationend", end);
  copy.addEventListener("animationcancel", end);
  doc.body.append(copy);
}

export function mergeShown<T>(prev: readonly Shown<T>[] | null, next: readonly T[], idOf: (item: T) => string, tailOnly = false): Shown<T>[] {
  const ids = next.map(idOf);
  if (!prev) return next.map((item, at) => ({ id: ids[at], item, fresh: false, leaving: false }));
  const before = new Map(prev.map((entry) => [entry.id, entry]));
  const where = new Map(ids.map((id, at) => [id, at]));
  let last = -1;
  if (tailOnly) ids.forEach((id, at) => before.get(id)?.leaving === false && (last = at));
  const out: Shown<T>[] = [];
  let at = 0;
  const take = (upTo: number) => {
    for (; at <= upTo; at += 1) {
      const was = before.get(ids[at]);
      out.push({ id: ids[at], item: next[at], fresh: was ? was.fresh && !was.leaving : at > last, leaving: false });
    }
  };
  for (const entry of prev) {
    const kept = where.get(entry.id);
    if (kept !== undefined) take(kept);
    else out.push(entry.leaving ? entry : { ...entry, fresh: false, leaving: true });
  }
  take(next.length - 1);
  return out;
}

export function dropShown<T>(list: readonly Shown<T>[], id: string): Shown<T>[] {
  return list.filter((entry) => entry.id !== id || !entry.leaving);
}
