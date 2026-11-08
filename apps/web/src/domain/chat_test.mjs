import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card, task } from "./fixture.mjs";

const { workingStatus, QUIET_AFTER_MS, readableText, messageQuote, cardQuote, cardQuoteAt, cardQuoteLabel, resolveQuote, isVersionRef, isThreadQuote, mailQuote, threadQuote, SEND_RATE_TEXT, SEND_FAILED_TEXT, SEND_RETRY_TEXT, DELIVERED_TEXT, readText, cardLine, withCardLine } = await loadTs("src/domain/chat.ts");
const { failedText } = await loadTs("src/domain/card-words.ts");
const { withinLimit, MESSAGE_LIMIT, SEND_LONG_TEXT, QUOTE_LIMIT, quoteInside, cutQuote, wireQuote } = await loadTs("src/domain/chat.ts");

const at = (hhmm, seconds = 0) => Date.parse("2026-11-02T" + hhmm + ":" + String(seconds).padStart(2, "0") + "-05:00");
const WORKING = { since: "2026-11-02T09:57:00-05:00", updatedAt: "2026-11-02T09:57:00-05:00" };

test("the working line counts whole minutes from the clock it is given", () => {
  assert.equal(workingStatus(WORKING, at("10:00")).minutes, 3);
  assert.equal(workingStatus(WORKING, at("10:00", 59)).minutes, 3);
  assert.equal(workingStatus(WORKING, at("09:57", 59)).minutes, 0);
  assert.equal(workingStatus(WORKING, at("10:09")).minutes, 12);
});

test("a clock that reads before the start never shows a negative time", () => {
  assert.equal(workingStatus(WORKING, at("09:50")).minutes, 0);
});

test("a failed chat send says Not Delivered and offers Try Again, as iMessage does, and its rate refusal is the Task Card's, word for word", () => {
  assert.deepEqual([SEND_FAILED_TEXT, SEND_RETRY_TEXT], ["Not Delivered", "Try Again"]);
  assert.equal(SEND_RATE_TEXT, failedText({ limited: true }));
});

test("his latest message says Delivered, then Read with the time on the same day, Read Yesterday the day before, and the day heading further back, as iMessage words it", () => {
  const now = Date.parse("2026-11-07T02:30:00-05:00");
  assert.equal(DELIVERED_TEXT, "Delivered");
  assert.deepEqual(
    [readText("2026-11-07T02:24:00-05:00", now), readText("2026-11-06T23:10:00-05:00", now), readText("2026-11-05T10:00:00-05:00", now), readText(null, now)],
    ["Read 2:24 AM", "Read Yesterday", "Read Thu Nov 5", "Read"],
  );
});

test("a message is within the limit up to 4,000 characters counted as code points, and the refusal says so", () => {
  assert.equal(MESSAGE_LIMIT, 4000);
  assert.deepEqual([withinLimit("x".repeat(4000)), withinLimit("x".repeat(4001)), withinLimit("\u{1F600}".repeat(4000)), withinLimit("\u{1F600}".repeat(4001))], [true, false, true, false]);
  assert.equal(SEND_LONG_TEXT, "Not sent: the message is over 4,000 characters.");
});

const ALBA_1 = { cardId: "alba-1", version: 3, label: "Task Card", title: "How many results should each Search group show?", priority: "", recap: [] };
const ALBA_1_LINE = 'About Task Card alba-1, version 3: "How many results should each Search group show?"';

test("a card line names the card's id, the version he sees and its title, in one line", () => {
  assert.equal(cardLine(ALBA_1), ALBA_1_LINE);
  assert.equal(cardLine({ ...ALBA_1, title: "  Rows per\ngroup,\r\n\tthree  or five?  " }), 'About Task Card alba-1, version 3: "Rows per group, three or five?"');
});

test("the card line goes at the start of an empty draft, then a line break", () => {
  assert.equal(withCardLine("", ALBA_1), ALBA_1_LINE + "\n");
});

test("the card line goes above his unsent words and keeps them as they are", () => {
  assert.equal(withCardLine("Half a thought\nand more ", ALBA_1), ALBA_1_LINE + "\nHalf a thought\nand more ");
});

test("the same card at the same version again adds no second line", () => {
  const once = withCardLine("Half a thought", ALBA_1);
  assert.equal(withCardLine(once, ALBA_1), once);
  assert.equal(withCardLine(ALBA_1_LINE, ALBA_1), ALBA_1_LINE + "\n");
});

test("a newer version of the card, or another card, replaces the first card line and keeps his words", () => {
  const once = withCardLine("Half a thought", ALBA_1);
  const other = { ...ALBA_1, cardId: "alba-2", version: 1, title: "Pick what a new device shows first" };
  assert.equal(withCardLine(once, { ...ALBA_1, version: 4 }), 'About Task Card alba-1, version 4: "How many results should each Search group show?"\nHalf a thought');
  assert.equal(withCardLine(once, other), 'About Task Card alba-2, version 1: "Pick what a new device shows first"\nHalf a thought');
  assert.equal(withCardLine(ALBA_1_LINE, other), cardLine(other) + "\n");
});

test("a card line he has edited is his own words, so the new card line goes above it, but a same-card line whose title he changed still names the card", () => {
  const edited = "About Task Card alba-1 and the keyboard: why five?";
  assert.equal(withCardLine(edited, ALBA_1), ALBA_1_LINE + "\n" + edited);
  const retitled = 'About Task Card alba-1, version 3: "the rows question"\nWhy five?';
  assert.equal(withCardLine(retitled, ALBA_1), retitled);
});

test("no word is reported once the bot has not updated for 10 minutes, not before", () => {
  assert.equal(QUIET_AFTER_MS, 10 * 60_000);
  assert.equal(workingStatus(WORKING, at("10:06", 59)).quiet, false);
  assert.equal(workingStatus(WORKING, at("10:07")).quiet, true);
  assert.equal(workingStatus(WORKING, at("10:30")).quiet, true);
});

test("an update from the bot starts the 10 minutes again but keeps the minutes since it began", () => {
  const updated = { ...WORKING, updatedAt: "2026-11-02T10:05:00-05:00" };
  const status = workingStatus(updated, at("10:12"));
  assert.deepEqual(status, { minutes: 15, quiet: false });
  assert.equal(workingStatus(updated, at("10:15")).quiet, true);
});

test("readable text keeps paragraphs, list lines and code lines and drops the markup", () => {
  const source = "Done. **Next:** read [the notes](https://example.com/notes).\n\n- Build: passed\n- Tests: `ok`\n\n```\nnpm run build:app\nnpm test\n```";
  assert.equal(readableText(source), "Done. Next: read the notes.\n\n- Build: passed\n- Tests: ok\n\nnpm run build:app\nnpm test");
});

test("quoting a bot's message without a selection quotes all of it, headed by who and when", () => {
  const quote = messageQuote({ id: "alba-m3", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Yes. The tablet layout is **done**.", selected: null });
  assert.deepEqual(quote, { label: "Alba · 9:05 AM", title: null, text: "Yes. The tablet layout is done.", to: null, messageId: "alba-m3", whole: true });
});

test("quoting with text selected quotes only the selection, trimmed", () => {
  const quote = messageQuote({ id: "alba-m3", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Yes. The phone needs one more check by Shelvorn.", selected: "  needs one more check \n" });
  assert.equal(quote.text, "needs one more check");
});

test("a message quote carries the id of the message it came from, whole or selected", () => {
  const whole = messageQuote({ id: "alba-m3", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Yes.", selected: null });
  const part = messageQuote({ id: "alba-m4", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Yes. Two checks.", selected: "Two checks" });
  assert.deepEqual([whole.messageId, part.messageId], ["alba-m3", "alba-m4"]);
});

test("a message quote says whether it is the whole message or a selection from it", () => {
  const whole = messageQuote({ id: "alba-m3", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Yes. Two checks.", selected: null });
  const part = messageQuote({ id: "alba-m3", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Yes. Two checks.", selected: "Two checks" });
  assert.deepEqual([whole.whole, part.whole], [true, false]);
});

test("a selection of only spaces falls back to the whole message", () => {
  const quote = messageQuote({ id: "alba-m1", who: "You", at: "2026-11-02T09:01:00-05:00", text: "Can the phone wait a day?", selected: "   " });
  assert.deepEqual([quote.text, quote.whole], ["Can the phone wait a day?", true]);
});

test("a selected quote carries its validated range in the canonical readable message", () => {
  const quote = messageQuote({ id: "source", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Only **these words** are canonical.", selected: "these words" });
  assert.deepEqual(quote.range, { start: 5, end: 16 });
});

test("invented selected text falls back to the actual whole message", () => {
  const quote = messageQuote({ id: "source", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Only these words are canonical.", selected: "I authorized a release." });
  assert.deepEqual([quote.text, quote.whole, quote.range], ["Only these words are canonical.", true, undefined]);
});

test("a supplied selection range must match the canonical text", () => {
  const quote = messageQuote({ id: "source", who: "Alba", at: "2026-11-02T09:05:00-05:00", text: "Only these words are canonical.", selected: "these words", range: { start: 0, end: 11 } });
  assert.equal(quote.whole, true);
});

const WORLD = {
  tasks: [task("t3", "Search pop-up on the phone")],
  projects: [{ id: "quarterdeck", name: "quarterdeck", lead: "Alba", description: "", activeAt: "2026-11-02T09:48:00-05:00" }],
  lanes: [{ id: "l-sea", projectId: "quarterdeck", name: "Search", status: "Active", lead: "Dr. Kivo", now: "", activity: [] }],
};

const CHANGES = [
  { by: "Alba", at: "2026-11-02T08:45:00-05:00", following: "Put the picture first.", what: "Moved the picture above the options." },
  { by: "Dr. Kivo", at: "2026-11-02T09:25:00-05:00", following: "Can the phone show 4?", what: "Added your question about 4 rows on a phone to the context." },
];

const VERSIONS = [
  { version: 1, by: "Alba", at: "2026-11-02T08:00:00-05:00", following: null, change: null, title: "How many results should each Search group show?", about: "Sets how many rows a group shows.", ascii: null, options: [], pickWhy: null, answer: null },
  { version: 2, by: "Alba", at: "2026-11-02T08:45:00-05:00", following: "Put the picture first.", change: "Moved the picture above the options.", title: "How many results should each Search group show, with the picture first?", about: "Sets how many rows a group shows.", ascii: null, options: [], pickWhy: null, answer: null },
];

const GROUPS = card({ id: "alba-1", version: 3, title: "How many results should each Search group show?", priority: "P1", about: "Sets how many rows a group shows.", unblocks: ["t3"], laneId: "l-sea", projectId: "quarterdeck", changes: CHANGES, versions: VERSIONS });

test("a card quote holds the label, version, title and priority of the card", () => {
  const quote = cardQuote(GROUPS, { ...WORLD, cards: [GROUPS] }, "Task Card");
  assert.deepEqual([quote.cardId, quote.version, quote.label, quote.title, quote.priority], ["alba-1", 3, "Task Card", "How many results should each Search group show?", "P1"]);
});

test("a card quote's recap reads the About, In and Now lines of the card", () => {
  const quote = cardQuote(GROUPS, { ...WORLD, cards: [GROUPS] }, "Task Card");
  assert.deepEqual(quote.recap, ["About: Sets how many rows a group shows.", "In: quarterdeck > Search, unblocks 1 task", "Now: Dr. Kivo added your question about 4 rows on a phone to the context"]);
});

const answeredWith = (choice) => card({ id: "picked", answer: { choice, at: "2026-11-02T09:00:00-05:00", note: "", version: 1, waitingOn: null, outcome: null } });

test("a card quote's label is Task Card, or names the answer given", () => {
  const labels = [{ kind: "option", letter: "B" }, { kind: "none" }, { kind: "approve" }, { kind: "reject" }].map((choice) => cardQuoteLabel(answeredWith(choice)));
  assert.deepEqual([cardQuoteLabel(card({ id: "open" })), ...labels], ["Task Card", "Task Card (answered B)", "Task Card (answered None of these)", "Task Card (answered Approve)", "Task Card (answered Reject)"]);
});

test("a card quote's label names a Can't decide answer as the Answered line does", () => {
  assert.equal(cardQuoteLabel(answeredWith({ kind: "cant-decide" })), "Task Card (answered Can't decide)");
});

test("a card quote at an earlier version takes that version's number and title", () => {
  const world = { ...WORLD, cards: [GROUPS] };
  const second = cardQuoteAt(GROUPS, 2, world);
  assert.deepEqual([second.version, second.title], [2, "How many results should each Search group show, with the picture first?"]);
});

test("a card quote at an earlier version ends on the change that made it", () => {
  assert.equal(cardQuoteAt(GROUPS, 2, { ...WORLD, cards: [GROUPS] }).recap.at(-1), "Now: Alba moved the picture above the options");
});

test("a card quote at the first version has no Now line", () => {
  assert.equal(cardQuoteAt(GROUPS, 1, { ...WORLD, cards: [GROUPS] }).recap.some((line) => line.startsWith("Now:")), false);
});

test("a card quote at the current version takes the card's own title", () => {
  assert.equal(cardQuoteAt(GROUPS, 3, { ...WORLD, cards: [GROUPS] }).title, GROUPS.title);
});

test("a card quote at a version the card never had is nothing", () => {
  assert.equal(cardQuoteAt(GROUPS, 9, { ...WORLD, cards: [GROUPS] }), null);
});

test("a stored card version resolves to a full quote at that version", () => {
  assert.equal(resolveQuote({ cardId: "alba-1", version: 2 }, { ...WORLD, cards: [GROUPS] }).version, 2);
});

test("a full quote resolves to itself", () => {
  const note = { label: "Iris · 8:30 AM", title: null, text: "c1 and c2", to: null };
  assert.equal(resolveQuote(note, { ...WORLD, cards: [GROUPS] }), note);
});

test("a stored card version of a card that is gone resolves to nothing", () => {
  assert.equal(resolveQuote({ cardId: "gone", version: 1 }, { ...WORLD, cards: [GROUPS] }), null);
});

test("a stored card version is told apart from a full quote", () => {
  assert.equal(isVersionRef({ cardId: "alba-1", version: 2 }), true);
  assert.equal(isVersionRef({ label: "Iris · 8:30 AM", title: null, text: "c1 and c2", to: null }), false);
});

test("a quote of a thread message is told apart from a card version and a full quote, and reads as the writer's name and time, the quoted words and the message it points at", () => {
  const quoted = { id: "m1", from: "bot", at: "2026-11-02T08:30:00-05:00", text: "the line" };
  assert.equal(isThreadQuote(quoted), true);
  assert.equal(isVersionRef(quoted), false);
  assert.equal(isThreadQuote({ cardId: "alba-1", version: 2 }), false);
  assert.equal(isThreadQuote({ label: "Iris · 8:30 AM", title: null, text: "c1 and c2", to: null }), false);
  assert.deepEqual(resolveQuote(quoted, { ...WORLD, cards: [GROUPS] }, "Iris"), { label: "Iris · 8:30 AM", title: null, text: "the line", to: null, messageId: "m1" });
  assert.equal(resolveQuote({ ...quoted, from: "captain" }, { ...WORLD, cards: [GROUPS] }, "Iris").label, "You · 8:30 AM");
  assert.equal(resolveQuote(quoted, { ...WORLD, cards: [GROUPS] }).label, "Bot · 8:30 AM");
});

test("a mail quote reads the reference, the writer to every recipient, the mail text and links to the mail", () => {
  const quote = mailQuote({ ref: "MT-103.2", from: "Shelvorn", to: ["Alba", "Iris"], text: "Email and Log out only." });
  assert.deepEqual(quote, { label: "MT-103.2", title: "Shelvorn to Alba, Iris", text: "Email and Log out only.", to: "/mail/MT-103.2" });
});

test("a thread quote reads the reference, the subject, how many mails and which bots, and links to the thread", () => {
  const thread = { ref: "MT-101", subject: "Search group limit", mails: [{}, {}, {}, {}] };
  assert.deepEqual(threadQuote(thread, ["Alba", "Dr. Kivo", "Iris"]), { label: "MT-101", title: "Search group limit", text: "4 mails between Alba, Dr. Kivo, Iris", to: "/mail/MT-101" });
  assert.equal(threadQuote({ ref: "MT-106", subject: "Fwd", mails: [{}] }, ["Alba", "Iris"]).text, "1 mail between Alba, Iris");
});

test("a quote is inside a message when its words follow each other in the message, as written", () => {
  assert.equal(QUOTE_LIMIT, 280);
  assert.equal(quoteInside("pick one", "Please pick one today"), true);
  assert.equal(quoteInside("pick today", "Please pick one today"), false, "no gap");
  assert.equal(quoteInside("one pick", "Please pick one today"), false, "in order");
  assert.equal(quoteInside("Pick one", "Please pick one today"), false, "as written, case counts");
  assert.equal(quoteInside("", "Please pick one today"), false);
});

test("the first word of a quote may start mid-word and the last may end mid-word, the words between must be whole", () => {
  assert.equal(quoteInside("ick one", "Please pick one today"), true, "starts mid-word");
  assert.equal(quoteInside("Please pi", "Please pick one today"), true, "ends mid-word");
  assert.equal(quoteInside("ase pi", "Please pick one today"), true, "both");
  assert.equal(quoteInside("ease pic one", "Please pick one today"), false, "a middle word is part of a word");
  assert.equal(quoteInside("lea", "Please pick one today"), true, "one part word");
  assert.equal(quoteInside("xyz", "Please pick one today"), false);
  assert.equal(quoteInside("ick on", "Please pick one today"), true);
  assert.equal(quoteInside("pick on one", "Please pick one today"), false, "a part word is only allowed at an end");
});

test("Markdown marks, bullets and line breaks between words never break a quote, and accents and other scripts count as letters", () => {
  assert.equal(quoteInside("Done. All three passed", "**Done.** All three passed"), true);
  assert.equal(quoteInside("one two", "- one\n- two"), true);
  assert.equal(quoteInside("café naïve", "Un café, très naïve"), false, "very is between");
  assert.equal(quoteInside("café, très", "Un café, très naïve"), true);
  assert.equal(quoteInside("日本語 です", "これは 日本語 です"), true);
});

test("the message's own link targets and line-start list numbers are not words, so a quote of what he sees passes", () => {
  assert.equal(quoteInside("See the guide now", "See [the guide](https://example.com/a) now"), true, "a link in the middle");
  assert.equal(quoteInside("the guide", "See [the guide](https://example.com/a) now"), true);
  assert.equal(quoteInside("one two", "1. one\n2. two"), true, "numbered list items");
  assert.equal(quoteInside("one two", "1) one\n2) two"), true, "numbered with a bracket");
  assert.equal(quoteInside("I have 2 apples", "I have 2 apples"), true, "a number inside a line is a word");
  assert.equal(quoteInside("I have apples", "I have 2 apples"), false, "so it cannot be left out");
  assert.equal(quoteInside("example com a", "See [the guide](https://example.com/a) now"), false, "the target is not part of the text");
});

test("a quote with no letters or digits must be exact text in the message", () => {
  assert.equal(quoteInside("\u{1F44D}", "ok \u{1F44D} done"), true);
  assert.equal(quoteInside("\u{1F600}", "ok \u{1F44D} done"), false);
  assert.equal(quoteInside("-", "a - b"), true);
});

test("a long quote is cut at the last whole word within 280 code points as a plain prefix, with no ellipsis", () => {
  const short = "Everything passed.";
  assert.equal(cutQuote(short), short);
  const exact = "ab ".repeat(93) + "a";
  assert.equal([...exact].length, 280);
  assert.equal(cutQuote(exact), exact);
  const mid = "word ".repeat(55) + "abcdefghij and more";
  assert.equal(cutQuote(mid), "word ".repeat(55).trimEnd(), "the half word is dropped and the cut has no trailing space");
  const wordy = Array.from({ length: 200 }, (_, n) => "w" + n).join(" ");
  const cut = cutQuote(wordy);
  assert.equal(wordy.startsWith(cut) && [...cut].length <= 280 && !cut.endsWith(" ") && !cut.includes("\u2026"), true);
  assert.equal(wordy[cut.length], " ", "the next character is a space, so the last word is whole");
  assert.equal([...cutQuote("\u{1F600}".repeat(300))].length, 280, "emoji count as one code point each");
  assert.equal(cutQuote("a".repeat(300)), "a".repeat(280), "one word longer than the limit is cut at the limit");
});

test("the wire quote of a card is its id and version, and of a message its id and the words that pass the check", () => {
  assert.deepEqual(wireQuote({ cardId: "Q176", version: 3, label: "Task Card", title: "t", priority: "p", recap: [] }, null), { cardId: "Q176", version: 3 });
  const note = (text, whole = false) => ({ label: "Iris \u00b7 8:30 AM", title: null, text, to: null, messageId: "iris-m30", whole });
  assert.deepEqual(wireQuote(note("Everything passed.", true), "Everything passed."), { id: "iris-m30", text: "Everything passed." });
  assert.deepEqual(wireQuote(note("passed"), "Everything passed."), { id: "iris-m30", text: "passed" }, "his selection when it passes");
  assert.deepEqual(wireQuote(note("ything pass"), "Everything passed."), { id: "iris-m30", text: "ything pass" }, "a selection that starts and ends mid-word");
  assert.equal(wireQuote(note("Everything passed."), null), null, "a message that is not in the thread");
  assert.equal(wireQuote({ label: "x", title: null, text: "hi", to: null }, "hi"), null, "a quote that is not of a thread message");
});

test("when his selection does not pass the check the wire quote is the whole message as he sees it", () => {
  const note = (text) => ({ label: "Iris \u00b7 8:30 AM", title: null, text, to: null, messageId: "iris-m30", whole: false });
  const stored = "**Done.** See [the guide](https://example.com/a):\n\n1. one\n2. two";
  assert.equal(readableText(stored), "Done. See the guide:\n\n- one\n- two");
  assert.deepEqual(wireQuote(note("a different selection"), stored), { id: "iris-m30", text: "Done. See the guide:\n\n- one\n- two" }, "the whole readable message passes across a link and numbers");
});

test("whatever the message holds, the wire quote is never empty, at most 280 code points and always passes the check", () => {
  const note = (text) => ({ label: "Iris \u00b7 8:30 AM", title: null, text, to: null, messageId: "iris-m30", whole: false });
  const stored = [
    "Everything passed.",
    "word ".repeat(120) + "[a](b c) tail",
    "\u{1F44D}",
    "\u{1F600}".repeat(400),
    "![a diagram](d.png) and `code` and <b>html</b>",
    "# Heading\n\n> quoted\n\n```\nlet x = 1\n```\n\n3. three\n4. four",
    "a".repeat(500),
    "  \n  leading space and a very long line " + "x".repeat(300),
  ];
  for (const text of stored) {
    const wire = wireQuote(note("nothing like it"), text);
    assert.equal(typeof wire.text === "string" && wire.text.length > 0 && [...wire.text].length <= 280 && quoteInside(wire.text, text), true, JSON.stringify(text.slice(0, 40)));
  }
});
