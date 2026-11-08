import { useSyncExternalStore } from "react";

export type Size = "narrow" | "sideways" | "mac";

const WIDE = "(min-width: 1000px)";
const MAC = "(min-width: 1300px)";

function sizeNow(): Size {
  if (window.matchMedia(MAC).matches) return "mac";
  return window.matchMedia(WIDE).matches ? "sideways" : "narrow";
}

function subscribe(onChange: () => void): () => void {
  const lists = [window.matchMedia(WIDE), window.matchMedia(MAC)];
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

export function useSize(): Size {
  return useSyncExternalStore(subscribe, sizeNow);
}
