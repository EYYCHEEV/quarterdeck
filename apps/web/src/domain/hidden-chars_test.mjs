import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const load = () => loadTs("src/domain/hidden-chars.ts");

const LISTED = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x2060, 0xfeff];
const markOf = (code) => "\\u{" + code.toString(16).toUpperCase() + "}";
const hasListed = (text) => [...text].some((character) => LISTED.includes(character.codePointAt(0)));

test("there are fifteen listed characters: the twelve bidirectional controls and three that take no width", () => {
  assert.equal(LISTED.length, 15);
  assert.equal(new Set(LISTED).size, 15);
});

for (const code of LISTED)
  test("the character " + markOf(code) + " is shown as that text and is not left in what is shown", async () => {
    const { shownText, hiddenParts } = await load();
    const raw = "pay" + String.fromCodePoint(code) + "eta";
    assert.equal(shownText(raw), "pay" + markOf(code) + "eta");
    assert.deepEqual(hiddenParts(raw), [{ text: "pay", mark: false }, { text: markOf(code), mark: true }, { text: "eta", mark: false }]);
    assert.equal(hasListed(shownText(raw)), false);
  });

test("the marker text is upper-case hex with no padding", async () => {
  const { shownText } = await load();
  assert.equal(shownText("\u061c"), "\\u{61C}");
  assert.equal(shownText("\ufeff"), "\\u{FEFF}");
  assert.equal(shownText("\u202e"), "\\u{202E}");
});

test("every listed character in one text is marked, each on its own, at the start, in a row and at the end", async () => {
  const { shownText, hiddenParts } = await load();
  const raw = LISTED.map((code) => String.fromCodePoint(code)).join("");
  assert.equal(shownText(raw), LISTED.map(markOf).join(""));
  assert.deepEqual(hiddenParts(raw), LISTED.map((code) => ({ text: markOf(code), mark: true })));
  assert.deepEqual(hiddenParts("\u202eabc\u202c"), [{ text: "\\u{202E}", mark: true }, { text: "abc", mark: false }, { text: "\\u{202C}", mark: true }]);
});

test("a joined emoji keeps its zero width joiners", async () => {
  const { shownText, hiddenParts } = await load();
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.equal(shownText("Family " + family + " here"), "Family " + family + " here");
  assert.deepEqual(hiddenParts(family), [{ text: family, mark: false }]);
});

test("a variation selector stays, for an emoji and for a script", async () => {
  const { shownText } = await load();
  for (const text of ["\u2764\uFE0F", "\u2764\uFE0E", "\u845B\u{E0100}", "\u1820\u180B"]) assert.equal(shownText(text), text);
});

test("a zero width non-joiner stays, as Persian needs it", async () => {
  const { shownText } = await load();
  const word = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
  assert.equal(shownText(word), word);
});

test("text with none of the listed characters comes back as it is, in one part, and no text gives no parts", async () => {
  const { shownText, hiddenParts } = await load();
  const plain = "Plain words, a tab\t, a line\nbreak, a non-breaking\u00A0space and a soft\u00ADhyphen.";
  assert.equal(shownText(plain), plain);
  assert.deepEqual(hiddenParts(plain), [{ text: plain, mark: false }]);
  assert.equal(shownText(""), "");
  assert.deepEqual(hiddenParts(""), []);
});

test("marker text a person typed is plain text, not a mark", async () => {
  const { shownText, hiddenParts } = await load();
  const typed = "the code \\u{202E} in words";
  assert.equal(shownText(typed), typed);
  assert.deepEqual(hiddenParts(typed), [{ text: typed, mark: false }]);
});

test("the parts put back together are the shown text", async () => {
  const { shownText, hiddenParts } = await load();
  const raw = "a\u200Bb \u202Ec\u2069 d\uFEFF";
  assert.equal(hiddenParts(raw).map((part) => part.text).join(""), shownText(raw));
});
