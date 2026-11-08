import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = process.env.NO_COMMENTS_ROOT ? path.resolve(process.env.NO_COMMENTS_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["src", "public", "fixtures", "tools"];
const SCAN_FILES = ["index.html", "motion-steps.mjs", "shell_test.mjs"];
const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "out", "dist", "preview", ".git"]);
const SKIP_FILES = new Set([path.join("tools", "lint", "no-comments.mjs")]);

const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|stylelint-disable/;

const write = process.argv.includes("--fix");
const findings = [];

function bodyOf(text) {
  if (text.startsWith("//")) return text.slice(2);
  if (text.startsWith("/*")) return text.slice(2, -2);
  if (text.startsWith("<!--")) return text.slice(4, -3);
  return text;
}

function classify(text) {
  return SUPPRESSION.test(bodyOf(text)) ? "suppression" : "comment";
}

function jsRanges(source, fileName) {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const seen = new Map();
  const add = (ranges) => {
    for (const r of ranges || []) seen.set(r.pos, { pos: r.pos, end: r.end });
  };
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(source, node.getFullStart()));
      add(ts.getTrailingCommentRanges(source, node.getFullStart()));
      add(ts.getTrailingCommentRanges(source, node.getEnd()));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return [...seen.values()].filter((r) => !source.slice(r.pos, r.end).startsWith("#!"));
}

function cssRanges(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else if (c === "/" && source[i + 1] === "*") {
      const j = source.indexOf("*/", i + 2);
      const end = j === -1 ? source.length : j + 2;
      out.push({ pos: i, end });
      i = end;
    } else i++;
  }
  return out;
}

function htmlRanges(source) {
  const out = [];
  const blocks = [];
  const re = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].indexOf(m[2], m[0].indexOf(">") + 1);
    blocks.push({ start, end: start + m[2].length });
    const inner = m[1].toLowerCase() === "script" ? jsRanges(m[2], "inline.js") : cssRanges(m[2]);
    for (const r of inner) out.push({ pos: start + r.pos, end: start + r.end });
  }
  const outside = (p) => !blocks.some((b) => p >= b.start && p < b.end);
  const cm = /<!--[\s\S]*?-->/g;
  while ((m = cm.exec(source))) if (outside(m.index)) out.push({ pos: m.index, end: m.index + m[0].length });
  return out;
}

function rangesFor(file, source) {
  const ext = path.extname(file);
  if (ext === ".css") return cssRanges(source);
  if (ext === ".html") return htmlRanges(source);
  return jsRanges(source, file);
}

function lineOf(source, pos) {
  let n = 1;
  for (let i = 0; i < pos; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

function strip(source, bad) {
  let result = source;
  for (const r of [...bad].sort((a, b) => b.pos - a.pos)) {
    const { pos, end } = r;
    const before = result[pos - 1];
    const after = result[end];
    const lineStart = result.lastIndexOf("\n", pos - 1) + 1;
    const lineEnd = result.indexOf("\n", end);
    const hasLineEnd = lineEnd === -1 ? result.length : lineEnd;
    const onlyThing = result.slice(lineStart, pos).trim() === "" && result.slice(end, hasLineEnd).trim() === "";
    if (onlyThing) {
      result = result.slice(0, lineStart) + result.slice(lineEnd === -1 ? hasLineEnd : lineEnd + 1);
      continue;
    }
    const glue = before && after && !/\s/.test(before) && !/\s/.test(after) ? " " : "";
    let left = pos;
    if (glue === "" && result[pos - 1] === " " && (after === "\n" || after === undefined)) left = pos - 1;
    result = result.slice(0, left) + glue + result.slice(end);
  }
  return result;
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (EXTENSIONS.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

const files = [
  ...SCAN_DIRS.flatMap((d) => (fs.existsSync(path.join(root, d)) ? walk(path.join(root, d), []) : [])),
  ...SCAN_FILES.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f)),
];
let stripped = 0;

for (const abs of files) {
  const rel = path.relative(root, abs);
  if (SKIP_FILES.has(rel)) continue;
  const source = fs.readFileSync(abs, "utf8");
  const ranges = rangesFor(abs, source).sort((a, b) => a.pos - b.pos);
  for (const r of ranges) {
    const text = source.slice(r.pos, r.end);
    findings.push({ rel, line: lineOf(source, r.pos), kind: classify(text), text: text.replace(/\s+/g, " ").slice(0, 80) });
  }
  if (write && ranges.length) {
    fs.writeFileSync(abs, strip(source, ranges));
    stripped += ranges.length;
  }
}

if (write) {
  console.log(`stripped ${stripped} comments in ${new Set(findings.map((f) => f.rel)).size} files`);
  process.exit(0);
}

for (const f of findings) console.log(`${f.rel}:${f.line} ${f.kind}`);
const byFile = new Map();
for (const f of findings) byFile.set(f.rel, (byFile.get(f.rel) || 0) + 1);
console.log(`no-comments: ${findings.length} violation(s) in ${byFile.size} file(s), ${files.length} files scanned`);
process.exit(findings.length ? 1 : 0);
