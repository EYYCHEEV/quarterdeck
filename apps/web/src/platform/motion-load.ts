import type * as Late from "./motion";

let late: typeof Late | undefined;

export const motion = () => (late?.ready() ? late : undefined);

export function loadMotion(): void {
  if (document.readyState !== "complete") return addEventListener("load", loadMotion);
  void import("./motion").then((module) => (late = module).start());
}
