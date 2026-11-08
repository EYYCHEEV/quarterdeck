export type ReturnKey = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey" | "isComposing" | "keyCode">;

type Viewport = Pick<VisualViewport, "width" | "height" | "scale" | "addEventListener" | "removeEventListener">;

export type KeyboardWindow = {
  visualViewport: Viewport | null;
  matchMedia: (query: string) => { matches: boolean };
  document: { activeElement: { tagName: string; isContentEditable?: boolean } | null };
};

export type KeyboardWatch = { up: () => boolean; stop: () => void };

const DROP = 150;
const TYPING: Record<string, true> = { INPUT: true, TEXTAREA: true };

export function enterSends(event: ReturnKey, keyboardUp: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !event.shiftKey && !event.altKey && !keyboardUp;
}

export function watchKeyboard(win: KeyboardWindow): KeyboardWatch {
  const viewport = win.visualViewport;
  const tallest = new Map<number, number>();
  const widthOf = (view: Viewport) => Math.round(view.width * view.scale);
  const typing = () => {
    const focused = win.document.activeElement;
    return focused !== null && (TYPING[focused.tagName] === true || focused.isContentEditable === true);
  };
  const sample = () => {
    if (!viewport || typing()) return;
    const width = widthOf(viewport);
    tallest.set(width, Math.max(tallest.get(width) ?? 0, viewport.height * viewport.scale));
  };
  sample();
  viewport?.addEventListener("resize", sample);
  return {
    up: () => {
      if (!win.matchMedia("(pointer: coarse)").matches) return false;
      if (!viewport) return true;
      const full = tallest.get(widthOf(viewport));
      return full === undefined || full - viewport.height * viewport.scale > DROP;
    },
    stop: () => viewport?.removeEventListener("resize", sample),
  };
}
