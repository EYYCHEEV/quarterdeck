import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export function Panel({ className, ...rest }: ComponentProps<"div">) {
  return <div className={cx("rounded-panel border border-line bg-panel", className)} {...rest} />;
}

export function Eyebrow({ className, ...rest }: ComponentProps<"h2">) {
  return <h2 className={cx("eyebrow flex items-center gap-2", className)} {...rest} />;
}

export function Section({ title, aside, className, children, ...rest }: Omit<ComponentProps<"section">, "title"> & { title: ReactNode; aside?: ReactNode }) {
  return (
    <section className={className} {...rest}>
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-1.5">
        <Eyebrow>{title}</Eyebrow>
        {aside}
      </div>
      {children}
    </section>
  );
}
