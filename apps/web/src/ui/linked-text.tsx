import { Fragment } from "react";
import { Link } from "./link";

export type TextLink = { text: string; to: string | null };

export function LinkedText({ parts }: { parts: TextLink[] }) {
  return (
    <>
      {parts.map((part, n) =>
        part.to ? (
          <Link key={n} to={part.to} className="rounded-md bg-raised px-1.5 py-px font-mono text-[.86em] whitespace-nowrap text-ink-2 hover:text-ink hover:underline">
            {part.text}
          </Link>
        ) : (
          <Fragment key={n}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
