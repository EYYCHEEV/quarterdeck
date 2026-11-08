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

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" };

const CELL = "border border-current/25 px-2.5 py-1.5 align-top";

const WRAP = "inline-block max-w-60 align-top wrap-anywhere";

function inline(nodes: MdInline[], text: TextRenderer, key: string, confirm: RequestBotLink): ReactNode[] {
  return nodes.map((node, n) => {
    const at = key + "." + n;
    if (node.t === "text") return <Fragment key={at}>{text(node.v, at)}</Fragment>;
    if (node.t === "code") return <code key={at} className="rounded-md border border-line bg-raised px-[5px] py-px font-mono text-[.86em]">{node.v}</code>;
    if (node.t === "bold") return <strong key={at} className="font-semibold text-ink">{inline(node.v, text, at, confirm)}</strong>;
    if (node.t === "em") return <em key={at}>{inline(node.v, text, at, confirm)}</em>;
    const content = <>
      <span className={node.href ? "underline decoration-link/35 underline-offset-3" : undefined}>{node.v}</span>
      <span className="break-all text-small text-ink-3">{node.destination}</span>
    </>;
    return node.href ? (
      <BotLink key={at} url={node.href} confirm={confirm} className="inline-grid min-h-11 max-w-full align-baseline text-link">
        {content}
      </BotLink>
    ) : (
      <span key={at} className="inline-grid max-w-full align-baseline">{content}</span>
    );
  });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [wrap, setWrap] = useState(true);
  return (
    <div className="overflow-hidden rounded-small border border-line-2 bg-side" data-testid="md-code-block">
      <div className="flex items-center justify-between gap-2 border-b border-line py-1 pr-1.5 pl-3 font-mono text-xs text-ink-3">
        <span>{lang || "text"}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 font-sans text-xs font-medium text-ink-2 hover:bg-raised hover:text-ink"
          >
            Wrap lines
          </button>
          <CopyButton value={code} label="Copy code" done="Copied" className="border-transparent bg-transparent" />
        </span>
      </div>
      <pre tabIndex={0} className={cx("m-0 overflow-x-auto px-3.5 py-3 font-mono text-code leading-[1.6] text-code-ink", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function block(node: MdBlock, text: TextRenderer, key: string, confirm: RequestBotLink): ReactNode {
  if (node.t === "p") return <p key={key}>{inline(node.v, text, key, confirm)}</p>;
  if (node.t === "h") return createElement("h" + Math.min(node.level + 2, 6), { key, className: "text-row font-semibold" }, inline(node.v, text, key, confirm));
  if (node.t === "code") return <CodeBlock key={key} code={node.v} lang={node.lang} />;
  if (node.t === "quote") return <blockquote key={key} className="grid min-w-0 gap-2.5 border-l-2 border-current/25 pl-3">{node.v.map((inner, n) => block(inner, text, key + "." + n, confirm))}</blockquote>;
  if (node.t === "table") {
    const cells = (row: MdInline[][], at: string, head: boolean) =>
      row.map((cell, n) => createElement(head ? "th" : "td", { key: n, className: cx(CELL, ALIGN[node.align[n] ?? "left"], head && "font-semibold") }, <span className={WRAP}>{inline(cell, text, at + "." + n, confirm)}</span>));
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
    <li key={n} className="mt-1 first:mt-0 marker:text-ink-3">
      {inline(item, text, key + "." + n, confirm)}
    </li>
  ));
  return node.t === "ul" ? <ul key={key} className="list-disc pl-[22px]">{items}</ul> : <ol key={key} className="list-decimal pl-[22px]">{items}</ol>;
}

const plain: TextRenderer = (text) => text;

export function Markdown({ blocks, botName, renderText = plain, className }: { blocks: MdBlock[]; botName: string; renderText?: TextRenderer; className?: string }) {
  return (
    <BotLinkConfirmation botName={botName}>
      {(confirm) => <div className={cx("grid min-w-0 gap-2.5 text-body leading-[1.6] [overflow-wrap:anywhere]", className)} data-testid="markdown">
        {blocks.map((node, n) => block(node, renderText, "b" + n, confirm))}
      </div>}
    </BotLinkConfirmation>
  );
}
