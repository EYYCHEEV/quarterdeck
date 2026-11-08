import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { rowPreview } = await loadTs("src/domain/chat-row.ts");

const PICTURE = { name: "shot.png", size: 10, type: "image/png" };

test("a row preview is his words with You: before them when he sent the last message, and the bot's words alone when it did", () => {
  assert.equal(rowPreview({ from: "captain", text: "Pick A on c1." }), "You: Pick A on c1.");
  assert.equal(rowPreview({ from: "bot", text: "Pick A on c1." }), "Pick A on c1.");
});

test("a row preview drops the markdown marks and runs lines together, as a plain line does", () => {
  assert.equal(rowPreview({ from: "captain", text: "**Pick** A\n\non c1" }), "You: Pick A on c1");
});

test("a row preview of a message with no words names what it carries: a picture, a count of pictures, a file's name, a count of files", () => {
  assert.equal(rowPreview({ from: "captain", text: "", attachments: [PICTURE] }), "You: Picture");
  assert.equal(rowPreview({ from: "captain", text: "", attachments: [PICTURE, PICTURE, PICTURE] }), "You: 3 pictures");
  assert.equal(rowPreview({ from: "captain", text: "", attachments: [{ name: "search-run.log", size: 403, type: "text/plain" }] }), "You: search-run.log");
  assert.equal(rowPreview({ from: "captain", text: "", attachments: [{ name: "a.log", size: 1, type: "text/plain" }, { name: "b.log", size: 1, type: "text/plain" }] }), "You: 2 files");
});

test("a row preview of pictures with files counts both, each in its own number", () => {
  const file = { name: "run.log", size: 1, type: "text/plain" };
  assert.equal(rowPreview({ from: "bot", text: "", attachments: [PICTURE, file] }), "1 picture and 1 file");
  assert.equal(rowPreview({ from: "bot", text: "", attachments: [PICTURE, PICTURE, file, file] }), "2 pictures and 2 files");
});

test("a row preview tells a picture from a file by its name, as the chat screen does", () => {
  assert.equal(rowPreview({ from: "captain", text: "", attachments: [{ name: "SHOT.PNG", size: 1, type: "" }] }), "You: Picture");
  assert.equal(rowPreview({ from: "captain", text: "", attachments: [{ name: "report.pdf", size: 1, type: "application/pdf" }] }), "You: report.pdf");
});

test("a row preview with words keeps the words and ignores what is attached", () => {
  assert.equal(rowPreview({ from: "captain", text: "See these", attachments: [PICTURE, PICTURE] }), "You: See these");
});

test("a row preview with no words and nothing attached is empty, never a bare You:", () => {
  assert.equal(rowPreview({ from: "captain", text: "" }), "");
  assert.equal(rowPreview({ from: "captain", text: "  ", attachments: [] }), "");
});
