import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../platform/copy";

export type CopyState = "idle" | "copied" | "failed";

export function useCopy(timeout = 1200): { copy: (value: string) => void; state: CopyState } {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    (value: string) => {
      copyText(value).then((done) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        setState(done ? "copied" : "failed");
        timer.current = window.setTimeout(() => {
          setState("idle");
          timer.current = null;
        }, timeout);
      });
    },
    [timeout],
  );
  return { copy, state };
}
