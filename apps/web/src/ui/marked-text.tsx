import { Fragment } from "react";

export type MarkPart = { text: string; mark: boolean };

const MARK = "mx-nudge inline-block rounded-key border border-dashed border-line-3 px-hair font-mono text-label leading-none font-regular text-ink-2 not-italic [direction:ltr] [unicode-bidi:isolate]";

export function MarkedText({ parts }: { parts: MarkPart[] }) {
  return (
    <>
      {parts.map((part, n) =>
        part.mark ? (
          <span key={n} data-testid="hidden-mark" className={MARK}>
            {part.text}
          </span>
        ) : (
          <Fragment key={n}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
