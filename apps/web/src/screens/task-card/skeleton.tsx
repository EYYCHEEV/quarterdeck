import type { CSSProperties } from "react";
import { cx } from "../../ui/cx";
import { SIX_TILES } from "./evidence";

function Bar({ className, style }: { className: string; style?: CSSProperties }) {
  return <span className={cx("block rounded-round bg-raised", className)} style={style} />;
}

function Block({ className, style }: { className: string; style?: CSSProperties }) {
  return <span className={cx("block rounded-panel bg-raised", className)} style={style} />;
}

export function CardSkeleton({ wide }: { wide: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="mt-s1 grid" data-testid="card-loading">
      <Bar className="mt-s1 h-[28px] w-[86%]" />
      <Bar className="mt-s2 h-[28px]" style={{ width: "52%" }} />
      <Bar className="mt-s3 h-s4 w-[58%]" />
      <Bar className="mt-s5 h-s3 w-[64px]" />
      <div className="mt-s3 grid gap-s2">
        <Bar className="h-s4" style={{ width: "92%" }} />
        <Bar className="h-s4" style={{ width: "78%" }} />
        <Bar className="h-s4" style={{ width: "64%" }} />
      </div>
      <Block className="mt-s4 h-[168px]" />
      <Bar className="mt-s5 h-s3 w-[80px]" />
      <div className={cx("mt-s3 grid gap-s2", !wide && "grid-cols-3")} style={wide ? SIX_TILES : undefined}>
        {Array.from({ length: wide ? 6 : 3 }, (_, at) => (
          <Block key={at} className="aspect-[4/3]" />
        ))}
      </div>
      <Block className="mt-s2 h-[56px]" />
      <Block className="mt-s5 h-[132px]" />
      <Block className="mt-s2 h-s7" />
      <Block className="mt-s2 h-s7" />
      <Block className="mt-s5 h-[68px]" />
      <Block className="mt-s2 h-s7" />
      <Block className="mt-s5 h-s7" />
    </div>
  );
}
