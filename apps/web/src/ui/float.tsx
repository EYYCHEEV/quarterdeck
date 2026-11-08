import { lazy, Suspense, useRef, useState, type ComponentProps, type ReactElement, type ReactNode, type RefObject } from "react";
import { cx } from "./cx";
import { useFrame } from "./head";
import { Icon, type IconName } from "./icon";

const MoreSheet = lazy(() => import("./more-sheet").then((m) => ({ default: m.MoreSheet })));

export const FLOAT_TOP_PAD = "pt-[calc(max(8px,env(safe-area-inset-top))+60px)]";

export const ROUND = "frost pointer-events-auto relative grid size-11 flex-none cursor-pointer place-items-center rounded-full text-ink";

const GLYPH_SIZE = { 20: "md", 16: "sm", 14: "xs" } as const;

export type GlyphName = IconName;

export function Glyph({ name, size = 20 }: { name: GlyphName; size?: keyof typeof GLYPH_SIZE }) {
  return <Icon name={name} size={GLYPH_SIZE[size]} />;
}

export function FloatTop({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between gap-2 pt-[max(8px,env(safe-area-inset-top))] pr-[max(12px,env(safe-area-inset-right))] pl-[max(12px,env(safe-area-inset-left))]">
      {children}
    </div>
  );
}

export function FloatToggle({ dot }: { dot: boolean }) {
  const frame = useFrame();
  if (!frame) return null;
  return (
    <button ref={frame.menuButton} type="button" onClick={frame.openMenu} aria-label={dot ? "Menu, new activity" : "Menu"} className={ROUND} data-float="toggle" data-testid="menu-btn">
      <Icon name="menu" />
      {dot && <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-page bg-brass" data-testid="menu-dot" />}
    </button>
  );
}

export function FloatCapsule({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="toolbar" aria-label={label} className="frost pointer-events-auto flex h-11 flex-none items-center rounded-full" data-float="capsule">
      {children}
    </div>
  );
}

export function FloatAction({ glyph, label, children, ...rest }: Omit<ComponentProps<"button">, "className" | "type"> & { glyph: GlyphName | ReactElement; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cx("inline-flex h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-full text-note font-semibold text-ink", children ? "pr-3 pl-3.5" : "px-0")}
      {...rest}
    >
      {typeof glyph === "string" ? <Icon name={glyph} /> : glyph}
      {children}
    </button>
  );
}

export type FloatMoreItem = { icon: IconName; label: string; onPick: (from: RefObject<HTMLElement | null>) => void };

export function FloatListTop({ label, dot }: { label: string; dot: boolean }) {
  const frame = useFrame();
  const search = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!frame) return null;
  return (
    <>
      <FloatTop>
        <FloatToggle dot={dot} />
        <FloatCapsule label={label}>
          <FloatAction ref={search} glyph="search" label="Search" onClick={() => frame.openSearch(search)} data-testid="float-search" />
          <FloatAction ref={more} glyph="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="float-more" />
        </FloatCapsule>
      </FloatTop>
      {open && (
        <Suspense fallback={null}>
          <MoreSheet
            items={[
              ...(__QD_SOURCE__ === "server" ? [] : [{ icon: "plus", label: "Add bot", onPick: frame.openAddBot } as const]),
              { icon: "settings", label: "Settings", onPick: frame.openSettings },
            ]}
            from={more}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
