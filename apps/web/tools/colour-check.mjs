import fs from "node:fs";
import path from "node:path";

const ROOT = ".";
const THEME = "src/ui/theme.css";
const SKIP = new Set(["dist", "node_modules", "preview", "tools", "design-check"]);
const TEXT = /\.(?:tsx?|mjs|js|css|html|json)$/;
const TEST = /_test\.mjs$/;
const PACKAGE_FILES = /^package(?:-lock)?\.json$/;
const BOT_PAGES = /^src\/data\/pages\/[^/]+\.html$/;
const COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(full);
    return TEXT.test(entry.name) && !PACKAGE_FILES.test(entry.name) ? [full] : [];
  });
}

function canonical(value) {
  const hex = /^#([0-9a-f]+)$/i.exec(value);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    const parts = digits.match(/../g).map((pair) => parseInt(pair, 16));
    if (parts.length === 4) parts[3] = Number((parts[3] / 255).toFixed(2));
    if (parts[3] === 1) parts.pop();
    return parts.join(",");
  }
  const rgb = /^rgba?\(([^)]*)\)$/i.exec(value);
  if (rgb) return rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number).join(",");
  return value.replace(/\s+/g, "");
}

const theme = new Set([...fs.readFileSync(THEME, "utf8").matchAll(/--color-[a-z0-9-]+:\s*([^;]+);/g)].map((match) => canonical(match[1].trim())));
const files = walk(ROOT)
  .map((file) => file.split(path.sep).join("/"))
  .filter((name) => name !== THEME && !BOT_PAGES.test(name));
const problems = [];
for (const name of files) {
  fs.readFileSync(name, "utf8").split("\n").forEach((line, at) => {
    for (const match of line.matchAll(COLOUR)) {
      if (TEST.test(name) && theme.has(canonical(match[0]))) continue;
      problems.push(`${name}:${at + 1}: ${match[0]} is a colour value; colours live only in ${THEME}${TEST.test(name) ? " (a test may assert only a value theme.css holds)" : ""}`);
    }
  });
}
if (problems.length) {
  for (const problem of problems) console.log(problem);
  console.log(`colour-check: FAIL, ${problems.length} colour values outside ${THEME}`);
  process.exit(1);
}
console.log(`colour-check: PASS, ${files.length} files under ${ROOT}/ hold no colour value outside ${THEME}; tests assert only theme.css values; the bot-made example pages in src/data/pages are bot content and keep their own colours`);
