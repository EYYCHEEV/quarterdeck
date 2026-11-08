import { useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import type * as Late from "../platform/motion";
import { motion } from "../platform/motion-load";

export type { RowMotion } from "../platform/motion";

export const PRESS = "press";
export const ARRIVE = "arrive";
export const RISE = "rise";
export const ALERT = "alert";

export const rowMotion = (entry: { id: string; fresh: boolean; leaving: boolean }, drop: (id: string) => void) => motion()?.rowMotion(entry, drop);

export const stillScreen = () => motion()?.stillScreen();

export function useShown<T>(items: readonly T[], idOf: (item: T) => string, reset: string, tailOnly = false) {
  const last = useRef<Late.Last<T>>(null);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const shown = motion()?.shownNow(last.current, items, idOf, reset, tailOnly) ?? items.map((item) => ({ id: idOf(item), item, fresh: false, leaving: false }));
  useLayoutEffect(() => {
    last.current = { reset, shown };
  });
  return { shown, drop: (id: string) => motion()?.dropFrom(last, id, redraw) };
}

export function useLeave(box: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const node = box.current;
    return () => motion()?.leaveCopy(node);
  }, [box]);
}
