import { BLOCKED_LINK, webAddress } from "./external-link";

export { webAddress as safeHref } from "./external-link";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "bold"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "link"; v: string; href: string | null; destination: string };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; v: Inline[] }
  | { t: "h"; v: Inline[]; level: number }
  | { t: "ul"; v: Inline[][] }
  | { t: "ol"; v: Inline[][] }
  | { t: "code"; v: string; lang: string }
  | { t: "quote"; v: Block[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(\S(?:[^\n]*?\S)?)\*\*|\*(?!\*)(\S(?:[^\n]*?[^\s*])?)\*(?!\*)|_(\S(?:[^\n]*?\S)?)_(?![\p{L}\p{N}_])/gu;
const WORD = /[\p{L}\p{N}_]/u;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const INDENTED = /^\s{2,}\S/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const DIVIDER = /^:?-+:?$/;
const QUOTE_DEPTH = 3;
const TABLE_COLUMNS = 20;
const TABLE_ROWS = 200;

function parseInline(text: string, bold = true, em = true): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (v: string) => {
    if (v) out.push({ t: "text", v });
  };
  const pattern = new RegExp(INLINE);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const index = match.index;
    const emphasis = match[5] ?? match[6];
    if ((match[4] !== undefined && !bold) || (emphasis !== undefined && (!em || (match[6] !== undefined && WORD.test(text[index - 1] ?? ""))))) {
      pattern.lastIndex = index + 1;
      continue;
    }
    push(text.slice(last, index));
    last = index + match[0].length;
    if (match[1] !== undefined) out.push({ t: "code", v: match[1] });
    else if (match[2] !== undefined) {
      const address = webAddress(match[3]);
      out.push({ t: "link", v: match[2], href: address?.href ?? null, destination: address?.host ?? BLOCKED_LINK });
    } else if (match[4] !== undefined) out.push({ t: "bold", v: parseInline(match[4], false, em) });
    else out.push({ t: "em", v: parseInline(emphasis ?? "", bold, false) });
  }
  push(text.slice(last));
  return out;
}

function cellsOf(line: string): string[] | null {
  let row = line.trim();
  if (!row.replace(/\\\|/g, "").includes("|")) return null;
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [""];
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") cells[cells.length - 1] += row[++i];
    else if (row[i] === "|") cells.push("");
    else cells[cells.length - 1] += row[i];
  }
  return cells.map((cell) => cell.trim());
}

const alignOf = (cell: string): Align => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : cell.startsWith(":") ? "left" : null);

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);

function tableAt(lines: string[], at: number): { block: Block; next: number } | null {
  if (!lines[at].includes("|") || !lines[at + 1]?.includes("|")) return null;
  const head = cellsOf(lines[at]);
  const divider = cellsOf(lines[at + 1]);
  if (!head || !divider || head.length !== divider.length || head.length > TABLE_COLUMNS || !divider.every((cell) => DIVIDER.test(cell))) return null;
  const rows: Inline[][][] = [];
  let next = at + 2;
  for (; next < lines.length && rows.length < TABLE_ROWS; next++) {
    const cells = startsBlock(lines[next]) ? null : cellsOf(lines[next]);
    if (!cells) break;
    const fitted = cells.length > head.length ? [...cells.slice(0, head.length - 1), cells.slice(head.length - 1).join(" | ")] : cells;
    rows.push(head.map((_, n) => parseInline(fitted[n] ?? "")));
  }
  return { block: { t: "table", align: divider.map(alignOf), head: head.map((cell) => parseInline(cell)), rows }, next };
}

function parseBlocks(source: string, depth: number): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: "p", v: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ t: list.kind, v: list.items.map((item) => parseInline(item)) });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const closing = FENCE.exec(lines[i]);
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length && !closing[2]) break;
        body.push(lines[i]);
      }
      blocks.push({ t: "code", v: body.join("\n"), lang: fence[2] });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ t: "h", v: parseInline(heading[2]), level: heading[1].length });
      continue;
    }
    if (depth < QUOTE_DEPTH && QUOTE.test(line)) {
      flushParagraph();
      flushList();
      const inner: string[] = [];
      for (; i < lines.length; i++) {
        const quoted = QUOTE.exec(lines[i]);
        if (!quoted) break;
        inner.push(quoted[1]);
      }
      i--;
      blocks.push({ t: "quote", v: parseBlocks(inner.join("\n"), depth + 1) });
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      flushParagraph();
      flushList();
      blocks.push(table.block);
      i = table.next - 1;
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    const marker = bullet || ordered;
    if (marker) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      list.items.push(marker[1]);
      continue;
    }
    if (list && INDENTED.test(line)) {
      list.items[list.items.length - 1] += "\n" + line.trim();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source, 0);
}

export function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => (node.t === "bold" || node.t === "em" ? inlineText(node.v) : node.v)).join("");
}

function blockWords(block: Block, parts: string[]): void {
  if (block.t === "code") parts.push(block.v);
  else if (block.t === "ul" || block.t === "ol") for (const item of block.v) parts.push(inlineText(item));
  else if (block.t === "quote") for (const inner of block.v) blockWords(inner, parts);
  else if (block.t === "table") for (const row of [block.head, ...block.rows]) for (const cell of row) parts.push(inlineText(cell));
  else parts.push(inlineText(block.v));
}

export function plainText(source: string): string {
  const parts: string[] = [];
  for (const block of parseMarkdown(source)) blockWords(block, parts);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
