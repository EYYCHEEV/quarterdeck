import { useEffect, useRef } from "react";
import { anyOverlayOpen } from "./overlay";

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]),textarea,select");
}

export function plainKey(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target);
}

export function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('a[href],button,summary,[role="button"],[role="radio"],[role="link"]') !== null;
}

export function useKeys(active: boolean, run: (event: KeyboardEvent) => void) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !plainKey(event) || anyOverlayOpen()) return;
      latest.current(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

export function useNextAction(active: boolean, run: () => void) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!active) return;
    const fire = () => latest.current();
    const start = window.setTimeout(() => {
      document.addEventListener("click", fire, true);
      document.addEventListener("input", fire, true);
    }, 0);
    return () => {
      window.clearTimeout(start);
      document.removeEventListener("click", fire, true);
      document.removeEventListener("input", fire, true);
    };
  }, [active]);
}
