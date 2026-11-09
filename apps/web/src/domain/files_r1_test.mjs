import assert from "node:assert/strict";
import test from "node:test";

const load = async () => {
  const { loadTs } = await import("../../tools/load-ts.mjs");
  return loadTs("src/domain/files-r1.ts");
};

const LIMITS = { fileBytes: 10485760, messageBytes: 26214400, count: 5 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const GIF = new TextEncoder().encode("GIF89a");
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 1, 2, 3, 4, ...new TextEncoder().encode("WEBP")]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const file = (name, parts, type = "") => new File(parts, name, { type });
const admitted = async (admit, files, attached = 0, bytes = 0) => {
  const { accepted, refused } = await admit(files, attached, bytes);
  return { names: accepted.map((one) => one.name), types: accepted.map((one) => one.type), refused };
};

test("the words before an upload are the plan's, and the sizes read as the server's limits", async () => {
  const r = await load();
  assert.equal(r.HEIC_TEXT, "This picture is in Apple's format. Choose it from Photos, or save it as a JPEG first.");
  assert.equal(r.typeText("run.exe"), "This file's type is not allowed: run.exe");
  assert.equal(r.bigText("big.png"), "This file is too big: big.png");
  assert.equal(r.blockedText("run.exe"), "This file was blocked: run.exe");
  assert.equal(r.countText(LIMITS.count), "A message can carry up to 5 files.");
  assert.equal(r.togetherText(LIMITS.messageBytes), "These files are too big together. A message can carry up to 25 MB.");
  assert.equal(r.UPLOADING_TEXT, "Uploading...");
  assert.equal(r.EXPIRED_TEXT, "Your files expired. Tap Try Again to upload them again.");
});

test("each refusal comes before any upload: one file too many, too big, too big together, a type off the list, heic, and a content that fails the server's first 1024 bytes", async () => {
  const r = await load();
  const admit = r.serverAdmit(LIMITS);
  const png = (name, extra = 0) => file(name, [PNG, new Uint8Array(extra)], "image/png");
  assert.deepEqual(await admitted(admit, [png("a.png"), file("b.pdf", [PDF]), file("c.gif", [GIF]), file("d.webp", [WEBP]), file("e.jpg", [JPEG])]), { names: ["a.png", "b.pdf", "c.gif", "d.webp", "e.jpg"], types: ["image/png", "application/pdf", "image/gif", "image/webp", "image/jpeg"], refused: [] });
  assert.deepEqual(await admitted(admit, [png("five.png"), png("six.png")], 4, 100), { names: ["five.png"], types: ["image/png"], refused: [r.countText(5)] });
  assert.deepEqual((await admitted(admit, [png("one.png")], 5, 100)).refused, [r.countText(5)]);
  assert.deepEqual(await admitted(admit, [png("edge.png", LIMITS.fileBytes - PNG.length), png("big.png", LIMITS.fileBytes - PNG.length + 1)]), { names: ["edge.png"], types: ["image/png"], refused: [r.bigText("big.png")] });
  assert.deepEqual((await admitted(admit, [png("fits.png", 1000)], 2, LIMITS.messageBytes - 1008)).names, ["fits.png"]);
  assert.deepEqual((await admitted(admit, [png("over.png", 1001)], 2, LIMITS.messageBytes - 1008)).refused, [r.togetherText(LIMITS.messageBytes)]);
  assert.deepEqual((await admitted(admit, [png("a.png", 6 * 1048576), png("b.png", 6 * 1048576)], 2, 14 * 1048576)).names, ["a.png"]);
  for (const [name, type] of [["run.exe", "application/x-msdownload"], ["draw.svg", "image/svg+xml"], ["notes.docx", ""], ["README", "text/plain"], ["page.html", "text/html"], ["app.log", "text/plain"]]) {
    assert.deepEqual((await admitted(admit, [file(name, ["hello"], type)])).refused, [r.typeText(name)], name);
  }
  for (const [name, type] of [["IMG_0001.HEIC", "image/heic"], ["IMG_0002.heif", ""], ["IMG_0003.heic", ""], ["shot.png", "image/heif"]]) {
    assert.deepEqual((await admitted(admit, [file(name, [PNG], type)])).refused, [r.HEIC_TEXT], name);
  }
  for (const [name, parts, type] of [["a.png", [JPEG], "image/png"], ["a.jpg", [PNG], "image/jpeg"], ["a.pdf", ["hello"], "application/pdf"], ["a.gif", [PNG], "image/gif"], ["a.webp", [new TextEncoder().encode("RIFF1234WEBX")], "image/webp"], ["empty.txt", [], "text/plain"]]) {
    assert.deepEqual((await admitted(admit, [file(name, parts, type)])).refused, [r.typeText(name)], name);
  }
  assert.deepEqual(await admitted(admit, [png("a.png"), file("run.exe", ["x"]), file("big.pdf", [PDF, new Uint8Array(LIMITS.fileBytes)])]), { names: ["a.png"], types: ["image/png"], refused: [r.typeText("run.exe"), r.bigText("big.pdf")] });
  assert.deepEqual((await admitted(admit, [file("x.exe", ["x"]), file("x.exe", ["y"])])).refused, [r.typeText("x.exe")]);
});

test("a text file passes the server's first 1024 bytes rule exactly: a BOM is skipped, a character cut at byte 1024 is fine, control characters other than tab, newline, return and form feed fail, and so does a start of < or #! after Python's whitespace", async () => {
  const r = await load();
  const admit = r.serverAdmit(LIMITS);
  const text = (name, parts) => admitted(admit, [file(name, parts, "text/plain")]);
  const passes = [
    ["plain.txt", ["hello\tthere\r\n\fend"]],
    ["bom.txt", [BOM, "hello"]],
    ["bom-twice.txt", [BOM, BOM, "<p>"]],
    ["cut.txt", ["a".repeat(1023), new Uint8Array([0xc3, 0xa9])]],
    ["late.txt", ["a".repeat(1024), "\u0001<"]],
    ["not-a-tag.txt", ["a <b> c"]],
    ["hash.txt", ["# heading"]],
  ];
  for (const [name, parts] of passes) assert.deepEqual((await text(name, parts)).refused, [], name);
  const fails = [
    ["tag.txt", ["<html>"]],
    ["spaced.txt", [" \t\r\n<html>"]],
    ["nbsp.txt", ["\u00a0\u3000<b>"]],
    ["bom-tag.txt", [BOM, "<b>"]],
    ["shebang.txt", ["#!/bin/sh"]],
    ["nul.txt", ["a\u0000b"]],
    ["vt.txt", ["a\u000bb"]],
    ["del.txt", ["a\u007fb"]],
    ["nel.txt", ["a\u0085b"]],
    ["bad.txt", [new Uint8Array([0x61, 0xff, 0x62])]],
    ["half.txt", [new Uint8Array([0xc3, 0x61])]],
    ["surrogate.txt", [new Uint8Array([0xed, 0xa0, 0x80])]],
    ["only-bom.txt", [BOM]],
  ];
  for (const [name, parts] of fails) assert.deepEqual((await text(name, parts)).refused, [r.typeText(name)], name);
  for (const [name, body, ok] of [["a.json", " {\"a\":1}", true], ["b.json", "[1]", true], ["c.json", "\"text\"", false], ["d.json", "1", false], ["e.json", "<x>", false]]) {
    assert.deepEqual((await admitted(admit, [file(name, [body], "application/json")])).refused, ok ? [] : [r.typeText(name)], name);
  }
});

test("the type claim comes from the extension when the browser's type is empty or an alias, an .md or .csv uploads under its own type, and a claim that names another type is refused", async () => {
  const r = await load();
  const cases = [
    ["notes.md", "", "text/markdown"],
    ["notes.md", "text/x-markdown", "text/markdown"],
    ["notes.md", "text/plain", "text/markdown"],
    ["data.csv", "application/vnd.ms-excel", "text/csv"],
    ["data.csv", "", "text/csv"],
    ["data.csv", "text/csv", "text/csv"],
    ["page.txt", "text/plain;charset=utf-8", "text/plain"],
    ["page.TXT", "", "text/plain"],
    ["a.json", "", "application/json"],
    ["photo.JPG", "image/jpeg", "image/jpeg"],
    ["photo.jpeg", "", "image/jpeg"],
    ["shot.png", "application/octet-stream", "image/png"],
    ["doc.pdf", "application/pdf", "application/pdf"],
  ];
  for (const [name, type, claim] of cases) assert.equal(r.claimedType(name, type), claim, name + " " + type);
  for (const [name, type] of [["shot.png", "application/pdf"], ["doc.pdf", "image/png"], ["data.csv", "text/html"], ["run.exe", ""], ["noext", "text/plain"], ["a.md.exe", "text/markdown"]]) {
    assert.equal(r.claimedType(name, type), null, name + " " + type);
  }
  const admit = r.serverAdmit(LIMITS);
  assert.deepEqual(await admitted(admit, [file("notes.md", ["# hi"]), file("data.csv", ["a,b"], "application/vnd.ms-excel"), file("more.md", ["- x"], "text/x-markdown")]), { names: ["notes.md", "data.csv", "more.md"], types: ["text/markdown", "text/csv", "text/markdown"], refused: [] });
  assert.deepEqual((await admitted(admit, [file("page.txt", ["<script>"], "text/plain")])).refused, [r.typeText("page.txt")]);
});

test("the picker lists only the round's types: photos the four picture types, files the nine extensions and their types, and never heic", async () => {
  const r = await load();
  assert.equal(r.PHOTO_ACCEPT, "image/png,image/jpeg,image/gif,image/webp");
  const files = r.FILE_ACCEPT.split(",");
  for (const one of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".md", ".csv", ".json", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"]) assert.ok(files.includes(one), one);
  for (const one of files) assert.doesNotMatch(one, /heic|heif|svg|html/i, one);
});
