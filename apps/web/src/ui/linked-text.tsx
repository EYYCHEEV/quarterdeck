import { Fragment } from "react";
import { Link } from "./link";

export type TextLink = { text: string; to: string | null };

export function LinkedText({ parts }: { parts: TextLink[] }) {
  return (
    <>
      {parts.map((part, n) =>
        part.to ? (
          <Link key={n} to={part.to} className="rounded-key bg-raised px-s1 py-nudge font-mono text-ref whitespace-nowrap text-ink-2 hover:text-ink hover:underline">
            {part.text}
          </Link>
        ) : (
          <Fragment key={n}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
