import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type RefObject } from "react";
import { motion } from "../platform/motion-load";

export function hrefFor(path: string): string {
  return __QD_PREVIEW__ ? "#" + path : path;
}

export function currentPath(): string {
  if (!__QD_PREVIEW__) return location.pathname;
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  return raw.split("?")[0] || "/";
}

let arrival: string | undefined;

export function go(path: string, { replace = false, focus }: { replace?: boolean; focus?: string } = {}) {
  const at = currentPath();
  if (path === at) return;
  arrival = focus;
  const url = __QD_PREVIEW__ ? location.pathname + location.search + "#" + path : path;
  if (replace) history.replaceState(null, "", url);
  else history.pushState({ at }, "", url);
  const update = () => window.dispatchEvent(new PopStateEvent("popstate"));
  const late = motion();
  if (late) late.moveScreen(update, at, path);
  else update();
}

let shown: string | undefined;

function shownPath(): string {
  return (shown ??= currentPath());
}

export function arrive(menu: RefObject<HTMLElement | null>): void {
  const focus = arrival;
  arrival = undefined;
  if (focus) (document.querySelector<HTMLElement>('[data-testid="' + focus + '"]') ?? menu.current)?.focus({ preventScroll: true });
}

function subscribe(onChange: () => void): () => void {
  const change = () => {
    shown = currentPath();
    onChange();
  };
  window.addEventListener("popstate", change);
  return () => window.removeEventListener("popstate", change);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, shownPath);
}

export function Link({ to, onClick, ...rest }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string }) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(to);
  };
  return <a href={hrefFor(to)} onClick={follow} {...rest} />;
}
