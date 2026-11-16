import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const [left, right] = process.argv.slice(2);
if (left === undefined || right === undefined) {
  console.error("usage: compare-builds.mjs <first build folder> <second build folder>");
  process.exit(2);
}

const listing = (root) => {
  const files = new Map();
  let bytes = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const body = readFileSync(full);
    bytes += body.byteLength;
    files.set(relative(root, full), createHash("sha256").update(body).digest("hex"));
  }
  return { files, bytes };
};

const first = listing(resolve(left));
const second = listing(resolve(right));
const names = [...new Set([...first.files.keys(), ...second.files.keys()])].sort();
const different = names.filter((name) => first.files.get(name) !== second.files.get(name));

for (const name of names) {
  const mark = different.includes(name) ? "DIFFERENT" : "same";
  console.log(`${mark}  ${first.files.get(name) ?? "missing"}  ${name}`);
}
console.log(`first build: ${first.files.size} files, ${first.bytes} bytes`);
console.log(`second build: ${second.files.size} files, ${second.bytes} bytes`);

if (names.length === 0 || different.length > 0) {
  console.log(`result: ${different.length} of ${names.length} files differ`);
  process.exit(1);
}
console.log(`result: both builds hold the same ${names.length} files, byte for byte`);
