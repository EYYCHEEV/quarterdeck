import { cx } from "./cx";

const SIZE = {
  xs: "size-[18px] text-label",
  sm: "size-[22px] text-label",
  md: "size-[28px] text-label",
  lg: "size-[36px] text-meta",
  xl: "size-[46px] text-body",
} as const;

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?")[0]).toUpperCase();
}

const centreInk = (el: HTMLElement | null) => {
  if (el) import("../platform/measure-text").then((measure) => measure.default(el));
};

export function Avatar({ name, size = "md", className }: { name: string; color?: string; size?: keyof typeof SIZE; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-avatar=""
      className={cx("inline-grid flex-none place-items-center rounded-round bg-panel leading-none font-strong text-ink-2 shadow-[inset_0_0_0_var(--line-w)_var(--color-line-3)]", SIZE[size], className)}
    >
      <span key={name} ref={centreInk} style={{ textBox: "cap alphabetic" }}>
        {initials(name)}
      </span>
    </span>
  );
}
