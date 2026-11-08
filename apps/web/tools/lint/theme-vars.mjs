import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = ".";
const THEME = "src/ui/theme.css";
const TAILWIND_THEME = "node_modules/tailwindcss/theme.css";
const SKIP = new Set(["dist", "node_modules", "preview", "tools", "design-check"]);
const TEXT = /\.(?:tsx?|mjs|js|css|html)$/;
const TEST = /_test\.mjs$/;
const PACKAGE_FILES = /^package(?:-lock)?\.json$/;
const BOT_PAGES = /^src\/data\/pages\/[^/]+\.html$/;
const LITERAL = /^\s*(--[\w-]+)\s*[,)]/;

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

const css = spawnSync(path.join("node_modules", ".bin", "tailwindcss"), ["-i", THEME, "--minify"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (css.status) {
  process.stderr.write(css.stderr);
  process.exit(css.status);
}

const themeNames = new Set();
for (const file of [THEME, TAILWIND_THEME]) {
  const text = fs.readFileSync(file, "utf8");
  for (const [from, to] of themeBlocks(text)) {
    for (const match of text.slice(from, to).matchAll(/(--[\w-]+)\s*:/g)) themeNames.add(match[1]);
  }
}

const dark = new Set();
const lightOnly = new Set();
for (const match of css.stdout.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const into = /data-appearance=["']?light\b/.test(match[1]) ? lightOnly : /:root|:host/.test(match[1]) ? dark : null;
  if (into) for (const declared of match[2].matchAll(/(--[\w-]+)\s*:/g)) into.add(declared[1]);
}

const themeText = fs.readFileSync(THEME, "utf8");
const themeRules = themeBlocks(themeText).reduce((text, [from, to]) => text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to), themeText);

const files = walk(ROOT)
  .map((file) => file.split(path.sep).join("/"))
  .filter((name) => !TEST.test(name) && !BOT_PAGES.test(name));
const problems = [];
const runtime = [];
for (const name of files) {
  const text = name === THEME ? themeRules : fs.readFileSync(name, "utf8");
  text.split("\n").forEach((line, at) => {
    for (const read of line.matchAll(/var\(/g)) {
      const after = line.slice(read.index + read[0].length);
      const literal = LITERAL.exec(after);
      if (!literal) {
        runtime.push(`${name}:${at + 1}: ${line.slice(read.index).trim()}`);
        continue;
      }
      const variable = literal[1];
      if (!themeNames.has(variable)) continue;
      const missing = [];
      if (!dark.has(variable)) missing.push("dark");
      if (!dark.has(variable) && !lightOnly.has(variable)) missing.push("light");
      if (missing.length) problems.push(`${name}:${at + 1}: ${variable} is a theme variable the built app.css does not define in the ${missing.join(" or ")} look; define it in @theme static in ${THEME}`);
    }
  });
}

const unchecked = runtime.length
  ? `${runtime.length} var() reads build their name at run time and are not checked:\n${runtime.map((read) => "  " + read).join("\n")}`
  : "no var() read builds its name at run time";
if (problems.length) {
  for (const problem of problems) console.log(problem);
  console.log(`theme-vars: FAIL, ${problems.length} reads of theme variables missing from the built app.css; ${unchecked}`);
  process.exit(1);
}
console.log(`theme-vars: PASS, ${files.length} files under ${ROOT}/ read only theme variables the built app.css defines in both looks; ${unchecked}`);
