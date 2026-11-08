import { useSyncExternalStore } from "react";

const PHONE = "(max-width: 699.98px)";

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(PHONE);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches);
}
