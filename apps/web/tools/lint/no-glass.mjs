import fs from "node:fs";
import path from "node:path";

const ROOT = ".";
const SKIP = new Set(["dist", "node_modules", "preview", "tools", "design-check"]);
const TEXT = /\.(?:tsx?|mjs|js|css|html)$/;
const PACKAGE_FILES = /^package(?:-lock)?\.json$/;
const GLASS = /\bfrost\b|backdrop-filter|backdrop-blur|backdropFilter/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(full);
    return TEXT.test(entry.name) && !PACKAGE_FILES.test(entry.name) ? [full] : [];
  });
}

const files = walk(ROOT).map((file) => file.split(path.sep).join("/"));
const problems = [];
for (const name of files) {
  fs.readFileSync(name, "utf8").split("\n").forEach((line, at) => {
    for (const match of line.matchAll(GLASS)) problems.push(`${name}:${at + 1}: ${match[0]} is glass styling; the design has no glass, so a floating part sits on a solid surface with a solid edge`);
  });
}
if (problems.length) {
  for (const problem of problems) console.log(problem);
  console.log(`no-glass: FAIL, ${problems.length} glass uses`);
  process.exit(1);
}
console.log(`no-glass: PASS, ${files.length} files under ${ROOT}/ use no glass`);
