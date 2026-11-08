import type { CSSProperties } from "react";
import { cx } from "../../ui/cx";
import { SIX_TILES } from "./evidence";

function Bar({ className, style }: { className: string; style?: CSSProperties }) {
  return <span className={cx("block rounded-full bg-raised", className)} style={style} />;
}

function Block({ className, style }: { className: string; style?: CSSProperties }) {
  return <span className={cx("block rounded-panel bg-raised", className)} style={style} />;
}

export function CardSkeleton({ wide }: { wide: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="mt-1 grid" data-testid="card-loading">
      <Bar className="mt-1 h-7 w-[86%]" />
      <Bar className="mt-2 h-7" style={{ width: "52%" }} />
      <Bar className="mt-3.5 h-4 w-[58%]" />
      <Bar className="mt-6 h-3 w-16" />
      <div className="mt-3 grid gap-2.5">
        <Bar className="h-4" style={{ width: "92%" }} />
        <Bar className="h-4" style={{ width: "78%" }} />
        <Bar className="h-4" style={{ width: "64%" }} />
      </div>
      <Block className="mt-4" style={{ height: 168 }} />
      <Bar className="mt-7 h-3" style={{ width: "5rem" }} />
      <div className={cx("mt-3 grid gap-2", !wide && "grid-cols-3")} style={wide ? SIX_TILES : undefined}>
        {Array.from({ length: wide ? 6 : 3 }, (_, at) => (
          <Block key={at} className="aspect-[4/3]" />
        ))}
      </div>
      <Block className="mt-2" style={{ height: "3.5rem" }} />
      <Block className="mt-7" style={{ height: 132 }} />
      <Block className="mt-2.5 h-12" />
      <Block className="mt-2.5 h-12" />
      <Block className="mt-6" style={{ height: 68 }} />
      <Block className="mt-2.5 h-12" />
      <Block className="mt-7 h-12" />
    </div>
  );
}
