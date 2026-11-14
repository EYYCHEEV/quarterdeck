import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(APP, "src");
const BOT_PAGES = path.join(SRC, "data");
const BLOCK = /<style[\s>]/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === BOT_PAGES ? [] : walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test("no part of the app writes a style block; the live policy would drop it", () => {
  const found = walk(SRC)
    .filter((file) => BLOCK.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(APP, file).split(path.sep).join("/"));
  assert.deepEqual(found, []);
  assert.doesNotMatch(fs.readFileSync(path.join(APP, "index.html"), "utf8"), BLOCK);
});

test("the Pages sheet is a file the app links, like the other screens' sheets", () => {
  assert.ok(fs.existsSync(path.join(APP, "public/document.css")), "public/document.css");
  assert.equal(fs.existsSync(path.join(SRC, "ui/document-style.ts")), false, "the sheet kept as text in src/ui/document-style.ts");
  assert.match(fs.readFileSync(path.join(SRC, "ui/document.tsx"), "utf8"), /<link rel="stylesheet" href="\/document\.css" precedence="document" \/>/);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, "ui/theme.css"), "utf8"), /document-style/);
});
