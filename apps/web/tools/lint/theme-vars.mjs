import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = ".";
const THEME = "src/ui/theme.css";
const TAILWIND_THEME = "node_modules/tailwindcss/theme.css";
const SKIP = new Set(["dist", "node_modules", "preview", "tools", "design-check"]);
const TEXT = /\.(?:tsx?|mjs|js|css|html)$/;
const TEST = /_test\.mjs$/;
const PACKAGE_FILES = /^package(?:-lock)?\.json$/;
const BOT_PAGES = /^src\/data\/pages\/[^/]+\.html$/;
const LITERAL = /^\s*(--[\w-]+)\s*[,)]/;
const SET = /(--[\w-]+)["'`]?\s*:/g;
const SET_IN_CODE = /setProperty\(\s*["'`](--[\w-]+)/g;
const RULE = /([^{}]+)\{([^{}]*)\}/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(full);
    return TEXT.test(entry.name) && !PACKAGE_FILES.test(entry.name) ? [full] : [];
  });
}

function themeBlocks(text) {
  const blocks = [];
  for (const match of text.matchAll(/@theme\b[^{]*\{/g)) {
    let depth = 1;
    let at = match.index + match[0].length;
    while (depth && at < text.length) {
      if (text[at] === "{") depth++;
      else if (text[at] === "}") depth--;
      at++;
    }
    blocks.push([match.index, at]);
  }
  return blocks;
}

const withoutThemeBlocks = (text) => themeBlocks(text).reduce((kept, [from, to]) => kept.slice(0, from) + kept.slice(from, to).replace(/[^\n]/g, " ") + kept.slice(to), text);

const namespaceOf = (variable) => /^--([a-z0-9]+)/i.exec(variable)?.[1] ?? "";

export function themeVarProblems(files, themes, built) {
  const themeNames = new Set();
  for (const text of themes) {
    for (const [from, to] of themeBlocks(text)) {
      for (const match of text.slice(from, to).matchAll(SET)) themeNames.add(match[1]);
    }
  }
  const namespaces = new Set([...themeNames].map(namespaceOf));

  const dark = new Set();
  const lightOnly = new Set();
  const set = new Set();
  for (const match of built.matchAll(RULE)) {
    const into = /data-appearance=["']?light\b/.test(match[1]) ? lightOnly : /:root|:host/.test(match[1]) ? dark : null;
    for (const declared of match[2].matchAll(SET)) {
      set.add(declared[1]);
      if (into) into.add(declared[1]);
    }
  }
  for (const { text } of files) {
    for (const declared of text.matchAll(SET)) set.add(declared[1]);
    for (const declared of text.matchAll(SET_IN_CODE)) set.add(declared[1]);
  }

  const problems = [];
  const runtime = [];
  for (const { name, text } of files) {
    const reads = name === THEME ? withoutThemeBlocks(text) : text;
    reads.split("\n").forEach((line, at) => {
      for (const read of line.matchAll(/var\(/g)) {
        const after = line.slice(read.index + read[0].length);
        const literal = LITERAL.exec(after);
        if (!literal) {
          runtime.push(`${name}:${at + 1}: ${line.slice(read.index).trim()}`);
          continue;
        }
        const variable = literal[1];
        if (!themeNames.has(variable)) {
          const namespace = namespaceOf(variable);
          if (namespaces.has(namespace) && !set.has(variable)) problems.push(`${name}:${at + 1}: ${variable} is in the theme's --${namespace} names but nothing defines it; read a name ${THEME} defines`);
          continue;
        }
        const missing = [];
        if (!dark.has(variable)) missing.push("dark");
        if (!dark.has(variable) && !lightOnly.has(variable)) missing.push("light");
        if (missing.length) problems.push(`${name}:${at + 1}: ${variable} is a theme variable the built app.css does not define in the ${missing.join(" or ")} look; define it in @theme static in ${THEME}`);
      }
    });
  }
  return { problems, runtime };
}

export function themeVarReport({ problems, runtime }, count) {
  const unchecked = runtime.length
    ? `${runtime.length} var() reads build their name at run time and are not checked:\n${runtime.map((read) => "  " + read).join("\n")}`
    : "no var() read builds its name at run time";
  if (problems.length) return { ok: false, lines: [...problems, `theme-vars: FAIL, ${problems.length} reads of theme variables that the built app.css lacks or that nothing defines; ${unchecked}`] };
  return { ok: true, lines: [`theme-vars: PASS, ${count} files under ${ROOT}/ read only theme variables the built app.css defines in both looks, and no name in a theme namespace that nothing defines; ${unchecked}`] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const css = spawnSync(path.join("node_modules", ".bin", "tailwindcss"), ["-i", THEME, "--minify"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (css.status) {
    process.stderr.write(css.stderr);
    process.exit(css.status);
  }
  const files = walk(ROOT)
    .map((file) => file.split(path.sep).join("/"))
    .filter((name) => !TEST.test(name) && !BOT_PAGES.test(name))
    .map((name) => ({ name, text: fs.readFileSync(name, "utf8") }));
  const report = themeVarReport(themeVarProblems(files, [THEME, TAILWIND_THEME].map((file) => fs.readFileSync(file, "utf8")), css.stdout), files.length);
  for (const line of report.lines) console.log(line);
  if (!report.ok) process.exit(1);
}
