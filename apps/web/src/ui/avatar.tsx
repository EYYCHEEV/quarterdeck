import { cx } from "./cx";

const SIZE = {
  xs: "size-[18px] text-initial-xs",
  sm: "size-[22px] text-initial-sm",
  md: "size-7 text-xs",
  lg: "size-9 text-sm",
  xl: "size-[46px] text-initial-xl",
} as const;

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?")[0]).toUpperCase();
}

const centreInk = (el: HTMLElement | null) => {
  if (el) import("../platform/measure-text").then((measure) => measure.default(el));
};

export function Avatar({ name, color = "var(--color-ink-2)", size = "md", className }: { name: string; color?: string; size?: keyof typeof SIZE; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-grid flex-none place-items-center rounded-full leading-none font-bold tracking-[-.02em]", SIZE[size], className)}
      style={{
        color,
        background: "color-mix(in srgb, " + color + " 17%, var(--color-panel))",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, " + color + " 28%, transparent)",
      }}
    >
      <span key={name} ref={centreInk} style={{ textBox: "cap alphabetic" }}>
        {initials(name)}
      </span>
    </span>
  );
}
