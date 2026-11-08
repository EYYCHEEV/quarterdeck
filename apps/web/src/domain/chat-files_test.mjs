import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { loadTs } from "../../tools/load-ts.mjs";

const { checkFile, sizeText, kindOf, MAX_FILES, admit, canRead, extensionOf, pictureCaption, inspectFile } = await loadTs("src/domain/chat-files.ts");

const MB = 1024 * 1024;
const file = (name, size, type) => ({ name, size, type });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64");

function officeBytes(root) {
  const parts = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    [root, '<?xml version="1.0"?><document/>'],
  ];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [path, text] of parts) {
    const name = Buffer.from(path);
    const body = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(body), 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("sizes read with one decimal under 10 KB, whole KB up to 1000 KB, then MB the same way", () => {
  assert.equal(sizeText(403), "0.4 KB");
  assert.equal(sizeText(14 * 1024), "14 KB");
  assert.equal(sizeText(14 * 1024 + 300), "14 KB");
  assert.equal(sizeText(150397), "147 KB");
  assert.equal(sizeText(1.5 * MB), "1.5 MB");
  assert.equal(sizeText(10 * MB), "10 MB");
  assert.equal(sizeText(11 * MB), "11 MB");
});

test("pictures are pictures, a log and a zip are files", () => {
  assert.equal(kindOf(file("shot.png", 1, "image/png")), "image");
  assert.equal(kindOf(file("build.log", 1, "")), "file");
  assert.equal(kindOf(file("out.zip", 1, "application/zip")), "file");
});

test("a picture over 10 MB is refused by name before it is sent", () => {
  assert.deepEqual(checkFile(file("big.png", 11 * MB, "image/png"), 0), { ok: false, reason: "big.png is too large (11 MB). Pictures can be up to 10 MB." });
  assert.deepEqual(checkFile(file("ok.png", 10 * MB, "image/png"), 0), { ok: true });
  assert.equal(checkFile(file("over.png", 10 * MB + 1, "image/png"), 0).ok, false);
});

test("another file over 50 MB is refused by name before it is sent", () => {
  assert.deepEqual(checkFile(file("trace.log", 51 * MB, "text/plain"), 0), { ok: false, reason: "trace.log is too large (51 MB). Files can be up to 50 MB." });
  assert.deepEqual(checkFile(file("trace.log", 50 * MB, "text/plain"), 0), { ok: true });
  assert.equal(checkFile(file("trace.log", 50 * MB + 1, "text/plain"), 0).ok, false);
});

test("an empty file is refused with its reason", () => {
  assert.deepEqual(checkFile(file("empty.txt", 0, "text/plain"), 0), { ok: false, reason: "empty.txt is empty." });
});

test("the metadata stage allows the listed extensions before their bytes are inspected", () => {
  const allowed = ["png", "jpg", "jpeg", "gif", "webp", "heic", "pdf", "txt", "md", "log", "csv", "json", "docx", "xlsx", "pptx"];
  for (const extension of allowed) {
    assert.deepEqual(checkFile(file("report." + extension, 5, ""), 0), { ok: true }, extension);
    assert.deepEqual(checkFile(file("REPORT." + extension.toUpperCase(), 5, ""), 0), { ok: true }, extension.toUpperCase());
  }
});

test("a program is refused by its kind with a plain line that names the kind", () => {
  assert.deepEqual(checkFile(file("setup.exe", 10, "application/x-msdownload"), 0), { ok: false, reason: "Can't send setup.exe here. .exe files are not allowed." });
});

test("a kind outside the list is refused the same way, whatever it is", () => {
  assert.deepEqual(checkFile(file("trace.zip", 10, "application/zip"), 0), { ok: false, reason: "Can't send trace.zip here. .zip files are not allowed." });
  assert.deepEqual(checkFile(file("run.sh", 10, "text/x-sh"), 0), { ok: false, reason: "Can't send run.sh here. .sh files are not allowed." });
  assert.deepEqual(checkFile(file("page.html", 10, "text/html"), 0), { ok: false, reason: "Can't send page.html here. .html files are not allowed." });
});

test("the end of the name decides the kind, so a second extension does not hide a program", () => {
  assert.deepEqual(checkFile(file("invoice.pdf.exe", 10, ""), 0), { ok: false, reason: "Can't send invoice.pdf.exe here. .exe files are not allowed." });
  assert.deepEqual(checkFile(file("setup.exe.txt", 10, ""), 0), { ok: true });
  assert.equal(extensionOf("archive.tar.gz"), "gz");
});

test("the letter case of the kind does not matter when it is refused", () => {
  assert.deepEqual(checkFile(file("SETUP.EXE", 10, ""), 0), { ok: false, reason: "Can't send SETUP.EXE here. .exe files are not allowed." });
});

test("a reported executable MIME cannot hide behind an allowed text extension", () => {
  assert.equal(checkFile(file("notes.txt", 10, "application/x-msdownload"), 0).ok, false);
});

test("a name with no kind is refused and says so", () => {
  assert.deepEqual(checkFile(file("README", 10, "text/plain"), 0), { ok: false, reason: "Can't send README here. It has no file kind." });
  assert.deepEqual(checkFile(file("notes.", 10, "text/plain"), 0), { ok: false, reason: "Can't send notes here. It has no file kind." });
});

test("a file that is both too large and of a refused kind is refused for its size first", () => {
  assert.deepEqual(checkFile(file("phone-recording.mov", 60 * MB, "video/quicktime"), 0), { ok: false, reason: "phone-recording.mov is too large (60 MB). Files can be up to 50 MB." });
  assert.deepEqual(checkFile(file("phone-recording.mov", 5 * MB, "video/quicktime"), 0), { ok: false, reason: "Can't send phone-recording.mov here. .mov files are not allowed." });
});

test("no more than the limit of files go in one message", () => {
  assert.deepEqual(checkFile(file("a.log", 5, ""), MAX_FILES), { ok: false, reason: "A message can carry up to " + MAX_FILES + " files." });
  assert.deepEqual(checkFile(file("a.log", 5, ""), MAX_FILES - 1), { ok: true });
});

test("a batch keeps the inspected files that pass, in order, and names each refusal", async () => {
  const batch = [new File([PNG], "a.png", { type: "image/png" }), new File(["program"], "setup.exe"), new File(["program"], "other.exe"), new File(["log"], "b.log"), new File([], "c.log")];
  const { accepted, refused } = await admit(batch, 0);
  assert.deepEqual(accepted.map((f) => f.name), ["a.png", "b.log"]);
  assert.deepEqual(refused, ["Can't send setup.exe here. .exe files are not allowed.", "Can't send other.exe here. .exe files are not allowed.", "c.log is empty."]);
});

test("a batch counts the files already attached against the limit of a message", async () => {
  const batch = [new File(["log"], "a.log"), new File(["log"], "b.log")];
  const { accepted, refused } = await admit(batch, MAX_FILES - 1);
  assert.deepEqual(accepted.map((f) => f.name), ["a.log"]);
  assert.deepEqual(refused, ["A message can carry up to " + MAX_FILES + " files."]);
});

test("text and logs can be read in place, pictures and archives cannot", () => {
  assert.equal(canRead(file("build.log", 5, "")), true);
  assert.equal(canRead(file("notes.md", 5, "text/markdown")), true);
  assert.equal(canRead(file("data.json", 5, "application/json")), true);
  assert.equal(canRead(file("shot.png", 5, "image/png")), false);
  assert.equal(canRead(file("trace.zip", 5, "application/zip")), false);
});

test("a picture's caption in the viewer is its description or name, who sent it and when", () => {
  const now = Date.parse("2026-11-02T10:00:00-05:00");
  assert.equal(pictureCaption({ name: "phone-search-1.png", alt: "Search on a phone" }, "You", "2026-11-02T08:36:00-05:00", now), "Search on a phone · You 8:36 AM");
  assert.equal(pictureCaption({ name: "shot.png" }, "Alba", "2026-11-01T16:00:00-05:00", now), "shot.png · Alba Sun 4:00 PM");
});

test("an executable renamed .txt is refused from its bytes", async () => {
  const result = await inspectFile(new File([new Uint8Array([77, 90, 144, 0, 3, 0, 0, 0])], "notes.txt", { type: "text/plain" }), 0);
  assert.equal(result.ok, false);
});

test("HTML renamed .pdf is refused from its bytes", async () => {
  const result = await inspectFile(new File(["<!doctype html><html><script>alert(1)</script></html>"], "report.pdf", { type: "application/pdf" }), 0);
  assert.equal(result.ok, false);
});

test("picture bytes with a text filename are refused", async () => {
  assert.equal((await inspectFile(new File([PNG], "notes.txt", { type: "text/plain" }), 0)).ok, false);
});

test("a picture's reported MIME must match its name", async () => {
  assert.equal((await inspectFile(new File([PNG], "shot.png", { type: "image/jpeg" }), 0)).ok, false);
});

test("an ordinary PNG is identified from its bytes", async () => {
  const result = await inspectFile(new File([PNG], "shot.png", { type: "image/png" }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.detectedType, "image/png");
});

test("a valid PDF is identified from its bytes", async () => {
  const result = await inspectFile(new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"], "report.pdf", { type: "application/pdf" }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.detectedType, "application/pdf");
});

test("a shell script renamed .txt is refused", async () => {
  assert.equal((await inspectFile(new File(["#!/bin/sh\nprintf hello\n"], "notes.txt", { type: "text/plain" }), 0)).ok, false);
});

test("a JSON name requires valid JSON bytes", async () => {
  assert.equal((await inspectFile(new File(["not JSON"], "report.json", { type: "application/json" }), 0)).ok, false);
});

test("the size refusal happens before any byte read", async () => {
  const large = new File([new Uint8Array(11 * MB)], "large.png", { type: "image/png" });
  let reads = 0;
  large.arrayBuffer = () => { reads += 1; throw new Error("must not read"); };
  const result = await inspectFile(large, 0);
  assert.equal(result.ok, false);
  assert.match(result.reason, /too large/);
  assert.equal(reads, 0);
});

test("a displayed filename is a normalized leaf without path or bidirectional controls", async () => {
  const result = await inspectFile(new File(["ordinary notes"], "..\\bad\u202e name.txt"), 0);
  assert.equal(result.ok, true);
  assert.deepEqual([result.file.name, result.file.type], ["bad_ name.txt", "text/plain"]);
});

test("an unreadable file is refused without a successful verdict", async () => {
  const unreadable = new File(["notes"], "notes.txt", { type: "text/plain" });
  unreadable.arrayBuffer = () => Promise.reject(new Error("read failed"));
  assert.equal((await inspectFile(unreadable, 0)).ok, false);
});

for (const [extension, root, mime] of [
  ["docx", "word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]) {
  test("OOXML " + extension + " container inventory identifies the document family", async () => {
    const result = await inspectFile(new File([officeBytes(root)], "report." + extension), 0);
    assert.equal(result.ok, true);
    assert.equal(result.detectedType, mime);
  });
}

test("an office container renamed as a different document family is refused", async () => {
  assert.equal((await inspectFile(new File([officeBytes("xl/workbook.xml")], "report.docx"), 0)).ok, false);
});

test("a truncated office directory cannot identify a document type", async () => {
  assert.equal((await inspectFile(new File([officeBytes("word/document.xml").subarray(0, -5)], "report.docx"), 0)).ok, false);
});

test("an inherited object key cannot act as an allowed extension", () => {
  assert.equal(checkFile(file("bad.__proto__", 5, ""), 0).ok, false);
  assert.equal(kindOf(file("bad.__proto__", 5, "")), "file");
});

test("repeat inspection reuses the immutable file's byte verdict", async () => {
  const original = new File(["notes"], "notes.txt");
  const read = original.arrayBuffer.bind(original);
  let reads = 0;
  original.arrayBuffer = () => { reads += 1; return read(); };
  const first = await inspectFile(original, 0);
  await inspectFile(original, 0);
  await inspectFile(first.file, 0);
  assert.equal(reads, 1);
});

test("generic HEIF branding cannot identify AVIF bytes as an allowed HEIC", async () => {
  const bytes = Buffer.alloc(28);
  bytes.writeUInt32BE(bytes.length);
  bytes.write("ftypmif1", 4);
  bytes.write("mif1avif", 16);
  assert.equal((await inspectFile(new File([bytes], "shot.heic", { type: "image/heic" }), 0)).ok, false);
});

test("a HEIC-compatible brand identifies the allowed HEIC family", async () => {
  const bytes = Buffer.alloc(28);
  bytes.writeUInt32BE(bytes.length);
  bytes.write("ftypmif1", 4);
  bytes.write("mif1heic", 16);
  const result = await inspectFile(new File([bytes], "shot.heic", { type: "image/heic" }), 0);
  assert.equal(result.ok, true);
  assert.equal(result.detectedType, "image/heic");
});
