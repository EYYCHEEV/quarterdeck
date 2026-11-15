import { createElement, Fragment, useState, type ReactNode } from "react";
import { BotLink, BotLinkConfirmation, type RequestBotLink } from "./bot-link";
import { cx } from "./cx";
import { CopyButton } from "./reference";

export type MdInline = { t: "text"; v: string } | { t: "code"; v: string } | { t: "bold"; v: MdInline[] } | { t: "em"; v: MdInline[] } | { t: "link"; v: string; href: string | null; destination: string };

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { t: "p"; v: MdInline[] }
  | { t: "h"; v: MdInline[]; level: number }
  | { t: "ul"; v: MdInline[][] }
  | { t: "ol"; v: MdInline[][] }
  | { t: "code"; v: string; lang: string }
  | { t: "quote"; v: MdBlock[] }
  | { t: "table"; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] };

type TextRenderer = (text: string, key: string) => ReactNode;

export type TextMarks = { draw: (text: string) => ReactNode; shown: (text: string) => string };

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" };

const CELL = "border border-line-3 px-s2 py-s1 align-top";

const WRAP = "inline-block max-w-[240px] align-top wrap-anywhere";

function inline(nodes: MdInline[], text: TextRenderer, key: string, confirm: RequestBotLink, marks: TextMarks): ReactNode[] {
  return nodes.map((node, n) => {
    const at = key + "." + n;
    if (node.t === "text") return <Fragment key={at}>{text(node.v, at)}</Fragment>;
    if (node.t === "code") return <code key={at} className="rounded-key border border-line bg-raised px-s1 py-nudge font-mono text-ref">{marks.draw(node.v)}</code>;
    if (node.t === "bold") return <strong key={at} className="font-strong text-ink">{inline(node.v, text, at, confirm, marks)}</strong>;
    if (node.t === "em") return <em key={at}>{inline(node.v, text, at, confirm, marks)}</em>;
    const content = <>
      <span className={node.href ? "underline decoration-current underline-offset-3" : undefined}>{marks.draw(node.v)}</span>
      <span className="break-all text-meta text-ink-3">{marks.draw(node.destination)}</span>
    </>;
    return node.href ? (
      <BotLink key={at} url={node.href} confirm={confirm} className="inline-grid min-h-hit max-w-full align-baseline text-inherit hover:text-hand">
        {content}
      </BotLink>
    ) : (
      <span key={at} className="inline-grid max-w-full align-baseline">{content}</span>
    );
  });
}

function CodeBlock({ code, lang, marks }: { code: string; lang: string; marks: TextMarks }) {
  const [wrap, setWrap] = useState(true);
  return (
    <div className="overflow-hidden rounded-key border border-line bg-side" data-testid="md-code-block">
      <div className="flex items-center justify-between gap-s2 border-b border-line py-s1 pr-s1 pl-s3 font-mono text-label text-ink-3">
        <span>{lang ? marks.draw(lang) : "text"}</span>
        <span className="flex items-center gap-s1">
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
            className="inline-flex min-h-hit cursor-pointer items-center rounded-panel px-s2 font-sans text-label font-strong text-ink-2 hover:bg-raised hover:text-ink"
          >
            Wrap lines
          </button>
          <CopyButton value={marks.shown(code)} label="Copy code" done="Copied" className="border-transparent bg-transparent" />
        </span>
      </div>
      <pre tabIndex={0} className={cx("m-0 overflow-x-auto px-s3 py-s3 font-mono text-meta leading-body text-ink", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
        <code>{marks.draw(code)}</code>
      </pre>
    </div>
  );
}

function block(node: MdBlock, text: TextRenderer, key: string, confirm: RequestBotLink, marks: TextMarks): ReactNode {
  if (node.t === "p") return <p key={key}>{inline(node.v, text, key, confirm, marks)}</p>;
  if (node.t === "h") return createElement("h" + Math.min(node.level + 2, 6), { key, className: "text-body font-strong" }, inline(node.v, text, key, confirm, marks));
  if (node.t === "code") return <CodeBlock key={key} code={node.v} lang={node.lang} marks={marks} />;
  if (node.t === "quote") return <blockquote key={key} className="grid min-w-0 gap-s2 border-l-2 border-line-3 pl-s3">{node.v.map((inner, n) => block(inner, text, key + "." + n, confirm, marks))}</blockquote>;
  if (node.t === "table") {
    const cells = (row: MdInline[][], at: string, head: boolean) =>
      row.map((cell, n) => createElement(head ? "th" : "td", { key: n, className: cx(CELL, ALIGN[node.align[n] ?? "left"], head && "font-strong") }, <span className={WRAP}>{inline(cell, text, at + "." + n, confirm, marks)}</span>));
    return (
      <div key={key} role="region" aria-label="Table" tabIndex={0} className="max-w-full overflow-x-auto">
        <table className="w-max border-collapse">
          <thead>
            <tr>{cells(node.head, key + ".h", true)}</tr>
          </thead>
          <tbody>
            {node.rows.map((row, r) => (
              <tr key={r}>{cells(row, key + "." + r, false)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const items = node.v.map((item, n) => (
    <li key={n} className="mt-s1 first:mt-0 marker:text-ink-3">
      {inline(item, text, key + "." + n, confirm, marks)}
    </li>
  ));
  return node.t === "ul" ? <ul key={key} className="list-disc pl-s5">{items}</ul> : <ol key={key} className="list-decimal pl-s5">{items}</ol>;
}

const plain: TextRenderer = (text) => text;

const UNMARKED: TextMarks = { draw: (text) => text, shown: (text) => text };

export function Markdown({ blocks, botName, renderText = plain, marks = UNMARKED, className }: { blocks: MdBlock[]; botName: string; renderText?: TextRenderer; marks?: TextMarks; className?: string }) {
  return (
    <BotLinkConfirmation botName={botName}>
      {(confirm) => <div className={cx("grid min-w-0 gap-s2 text-body leading-body [overflow-wrap:anywhere]", className)} data-testid="markdown">
        {blocks.map((node, n) => block(node, renderText, "b" + n, confirm, marks))}
      </div>}
    </BotLinkConfirmation>
  );
}
