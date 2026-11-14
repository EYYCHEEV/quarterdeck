import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const FACES = [
  ["Plex Sans", "400", "ibm-plex-sans-latin-400-normal.woff2", "3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e"],
  ["Plex Sans", "600", "ibm-plex-sans-latin-600-normal.woff2", "8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f"],
  ["Plex Mono", "400", "ibm-plex-mono-latin-400-normal.woff2", "08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7"],
  ["Plex Mono", "600", "ibm-plex-mono-latin-600-normal.woff2", "0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83"],
];

const LICENCES = [
  ["IBM-PLEX-SANS", "d0283623ef57e722fd0eb688a8041589670c608ab780cd3612d06ba6f153d3fd"],
  ["IBM-PLEX-MONO", "23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f"],
];

const MANIFESTS = ["../../../deploy/qd-web/package-manifest.json", "../../../deploy/captain-app/package-manifest.json"];
const NOTICES = at("../../../THIRD_PARTY_NOTICES.md");

const field = (block, name) => new RegExp("(?:^|[;{\\s])" + name + ":\\s*([^;]+);").exec(block)?.[1].trim();

test("the app ships exactly the four pinned font files", () => {
  const shipped = fs.readdirSync(at("../public/fonts")).filter((name) => name.endsWith(".woff2")).sort();
  assert.deepEqual(shipped, FACES.map((face) => face[2]).sort());
  for (const [, , file, hash] of FACES) assert.equal(sha256(at("../public/fonts/" + file)), hash, file);
});

test("the theme names each face once, with its file, its weight and swap", () => {
  const theme = fs.readFileSync(at("../src/ui/theme.css"), "utf8");
  const blocks = [...theme.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
  const got = blocks.map((block) => [field(block, "font-family"), field(block, "font-weight"), field(block, "font-style"), field(block, "font-display"), field(block, "src")]).sort();
  const want = FACES.map(([family, weight, file]) => ['"' + family + '"', weight, "normal", "swap", 'url("fonts/' + file + '") format("woff2")']).sort();
  assert.deepEqual(got, want);
});

test("each licence text ships beside the fonts and sits in the licenses folder", () => {
  for (const [name, hash] of LICENCES) {
    assert.equal(sha256(at("../public/fonts/" + name + "-LICENSE.txt")), hash, name + " beside the fonts");
    assert.equal(sha256(at("../../../licenses/" + name + "-OFL-1.1.txt")), hash, name + " in licenses");
  }
});

test("the notices file names IBM Plex, its version and licence, and points at both texts", () => {
  const notices = fs.readFileSync(NOTICES, "utf8");
  const section = /^## IBM Plex\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(notices)?.[1] ?? "";
  assert.notEqual(section, "", "an IBM Plex section");
  for (const part of ["@fontsource/ibm-plex-sans", "@fontsource/ibm-plex-mono", "5.3.0", "OFL-1.1", "(licenses/IBM-PLEX-SANS-OFL-1.1.txt)", "(licenses/IBM-PLEX-MONO-OFL-1.1.txt)", "apps/web/public/fonts"]) {
    assert.ok(section.includes(part), part);
  }
});

test("both package manifests carry the hash of the notices file", () => {
  const hash = sha256(NOTICES);
  for (const manifest of MANIFESTS) {
    assert.ok(fs.readFileSync(at(manifest), "utf8").includes('"THIRD_PARTY_NOTICES.md": "' + hash + '"'), manifest);
  }
});
