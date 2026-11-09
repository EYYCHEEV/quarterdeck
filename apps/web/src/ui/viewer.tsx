import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Button, IconButton } from "./button";
import { useOverlay } from "./overlay";

export type ViewerItem = { id: string; kind: "image" | "video"; src: string; poster: string | null; type: string | null; caption: string };

const SWIPE = 50;
const CONTROLS = 56;
const FILL = "absolute inset-0 h-full w-full object-contain";

function playable(item: ViewerItem): boolean {
  return !item.type || document.createElement("video").canPlayType(item.type) !== "";
}

function Video({ item }: { item: ViewerItem }) {
  const [failed, setFailed] = useState(() => !item.src || !playable(item));
  if (failed)
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4" data-testid="viewer-no-play">
        {item.poster !== null && <img src={item.poster || undefined} alt={item.caption} className="min-h-0 max-w-full flex-1 object-contain" />}
        <p className="flex-none text-meta text-ink-2">This browser cannot play this video.</p>
        {item.src && (
          <a href={item.src} download className="inline-flex min-h-11 flex-none items-center px-1.5 text-meta text-link hover:underline">
            Download the video
          </a>
        )}
      </div>
    );
  return <video src={item.src} poster={item.poster || undefined} controls playsInline preload="metadata" aria-label={item.caption} className={FILL} onError={() => setFailed(true)} data-testid="viewer-video" />;
}

function Picture({ item }: { item: ViewerItem }) {
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  if (failed)
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4" data-testid="viewer-failed">
        <p className="text-meta text-ink-2">This picture did not load.</p>
        <Button
          onClick={() => {
            setFailed(false);
            setTries(tries + 1);
          }}
          data-testid="viewer-retry"
        >
          Try again
        </Button>
      </div>
    );
  return <img key={tries} src={item.src || undefined} alt={item.caption} className={FILL} draggable={false} onError={() => setFailed(true)} data-testid="viewer-image" />;
}

export function Viewer<T extends ViewerItem>({
  items,
  start,
  label,
  onClose,
  returnTo,
  caption,
  actions,
}: {
  items: T[];
  start: number;
  label: string;
  onClose: () => void;
  returnTo?: RefObject<HTMLElement | null>;
  caption: (item: T) => string;
  actions?: (item: T, show: (id: string) => void) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose, returnTo);
  const [index, setIndex] = useState(start);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const item = items[index];
  const step = (by: number) => setIndex((n) => Math.min(items.length - 1, Math.max(0, n + by)));
  const show = (id: string) => {
    const at = items.findIndex((other) => other.id === id);
    if (at >= 0) setIndex(at);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else return;
    event.preventDefault();
  };
  const onDown = (event: PointerEvent) => {
    const target = event.target;
    const onControls = target instanceof HTMLVideoElement && event.clientY > target.getBoundingClientRect().bottom - CONTROLS;
    swipe.current = onControls ? null : { x: event.clientX, y: event.clientY };
  };
  const onUp = (event: PointerEvent) => {
    const from = swipe.current;
    swipe.current = null;
    if (!from) return;
    const dx = event.clientX - from.x;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(event.clientY - from.y)) step(dx < 0 ? 1 : -1);
  };
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      data-pop="viewer"
      onKeyDown={onKey}
      className="fixed inset-0 z-50 flex flex-col bg-page outline-none"
    >
      <div className="flex min-h-15 flex-none items-center gap-2 py-2 pr-2 pl-4 pt-[max(8px,env(safe-area-inset-top))]">
        <span className="min-w-0 flex-1 text-meta text-ink-2" data-testid="viewer-count">
          {index + 1} of {items.length}
        </span>
        <IconButton icon="x" label="Close" onClick={onClose} className="rounded-full" data-autofocus="" />
      </div>
      <div className="relative min-h-0 flex-1 touch-pan-y select-none" onPointerDown={onDown} onPointerUp={onUp} data-testid="viewer-stage">
        {item.kind === "video" ? <Video key={item.id} item={item} /> : <Picture key={item.id} item={item} />}
        <IconButton icon="back" label="Previous" onClick={() => step(-1)} aria-disabled={index === 0} className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-panel aria-disabled:cursor-default aria-disabled:opacity-40" />
        <IconButton icon="chevR" label="Next" onClick={() => step(1)} aria-disabled={index === items.length - 1} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-panel aria-disabled:cursor-default aria-disabled:opacity-40" />
      </div>
      <div className="flex-none border-t border-line px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <p className="text-small text-ink" data-testid="viewer-caption">
          {caption(item)}
        </p>
        {actions && <div className="mt-1 flex flex-wrap gap-x-2">{actions(item, show)}</div>}
      </div>
    </div>
  );
}
