import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm" });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { BUDGET } = await load("src/data/card.ts");
const { exampleCardThreads } = await load("src/data/example-cards.ts");

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const NO_ANSWER_LINE = /\bno answer by (?:the )?due\b/i;
const CARD_ID = /^(?:Q[1-9][0-9]{0,8}|[a-z][a-z0-9-]{0,31}-[1-9][0-9]{0,8})$/;
const COMMENT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const lines = (text) => text.split("\n");
const strings = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);
const kindOf = (card) => card.kind ?? "decision";
const threads = exampleCardThreads();

function checkOptions(options, where) {
  assert.ok(options.length >= BUDGET.options_min && options.length <= BUDGET.options_max, where + " has 2 to 4 options");
  assert.equal(options.filter((option) => option.pick === true).length, 1, where + " has exactly one pick");
  const letters = options.map((option) => option.label.slice(0, 3));
  assert.ok(letters.every((letter) => /^[A-D]\. $/.test(letter)), where + " labels start with a letter");
  assert.equal(new Set(letters).size, letters.length, where + " uses each letter once");
  for (const option of options) {
    assert.ok(option.label.length <= BUDGET.label, where + " label length");
    assert.ok(!/can't decide|none of these/i.test(option.label), where + " repeats an extra choice");
  }
}

test("there are three to five example cards with their threads", () => {
  assert.ok(threads.length >= 3 && threads.length <= 5);
  const ids = threads.map((thread) => thread.card.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every card names itself and keeps inside the contract's budgets", () => {
  for (const { card } of threads) {
    const where = card.id;
    assert.equal(card.qd, "card/1");
    assert.equal(card.card, card.id);
    assert.match(card.id, CARD_ID);
    assert.ok(card.id.length <= 32);
    assert.ok(card.project.length > 0 && !card.project.includes("\n"));
    assert.ok(card.title.length <= BUDGET.title && !card.title.includes("\n"), where + " title");
    assert.ok(card.about.length <= BUDGET.about && !card.about.includes("\n"), where + " about");
    const context = lines(card.context);
    assert.ok(context.length >= 1 && context.length <= BUDGET.context_lines && context.every((line) => line.trim()), where + " context");
    if (card.ascii !== undefined) {
      const art = lines(card.ascii);
      assert.ok(art.length <= BUDGET.art_lines, where + " picture lines");
      assert.ok(art.every((line) => line.length <= BUDGET.art_cols), where + " picture columns");
    }
    if (card.pick_why !== undefined) assert.ok(card.pick_why.length <= BUDGET.pick_why, where + " pick_why");
    if (card.you_do !== undefined) assert.ok(card.you_do.length <= BUDGET.you_do, where + " you_do");
    if (card.skip !== undefined) assert.ok(card.skip.length <= BUDGET.skip, where + " skip");
    if (card.due !== undefined) {
      assert.match(card.due, ISO_WITH_OFFSET);
      assert.match(card.skip ?? "", NO_ANSWER_LINE, where + " says what happens with no answer");
    }
    assert.ok(card.category.length >= 1 && card.category.length <= 2);
    assert.equal(new Set(card.category).size, card.category.length);
    if (card.commands) {
      assert.ok(card.commands.length <= BUDGET.command_blocks);
      assert.ok(card.commands.every((command) => command.where.trim() && command.run.trim()));
    }
    for (const [term, meaning] of card.words ?? []) assert.ok(term.trim() && meaning.trim());
  }
});

test("a decision or an action card has options and a pick; an FYI card has none", () => {
  for (const { card } of threads) {
    if (kindOf(card) === "fyi") {
      assert.equal(card.options, undefined);
      assert.equal(card.pick_why, undefined);
      continue;
    }
    checkOptions(card.options ?? [], card.id);
    assert.ok(card.pick_why && card.pick_why.trim());
    if (kindOf(card) === "action") assert.ok(card.commands && card.commands.length >= 1, card.id + " action needs a command");
  }
});

test("a design card carries both principles lines", () => {
  for (const { card } of threads.filter((thread) => thread.card.category.includes("design"))) {
    assert.ok(card.principles && card.principles.follows.trim() && card.principles.departs.trim());
  }
});

test("the examples cover each shape the Task Card view needs", () => {
  const cards = threads.map((thread) => thread.card);
  assert.ok(cards.some((card) => kindOf(card) === "decision" && card.ascii && card.options && card.due && card.skip), "decision with a picture, options, due and no-answer line");
  assert.ok(cards.some((card) => kindOf(card) === "action" && card.commands?.length), "action with commands");
  assert.ok(
    threads.some((thread) => thread.card.category.includes("design") && thread.card.principles && thread.comments.some((item) => item.body.options)),
    "design card with principles and a comment that has options",
  );
  assert.ok(!cards.some((card) => kindOf(card) === "fyi"), "no FYI card (section 11)");
  assert.ok(threads.some((thread) => thread.answers.some((answer) => !answer.comment && answer.rev < thread.rev)), "answer on an older revision");
  assert.ok(threads.some((thread) => thread.answers.some((answer) => answer.comment)), "a pick on a small card in the thread");
  assert.ok(threads.some((thread) => thread.comments.length === 0 && thread.answers.length === 0), "card with no thread yet");
});

test("every comment belongs to its card, and one with options is a small card he can pick on", () => {
  for (const thread of threads) {
    let last = "";
    for (const item of thread.comments) {
      assert.equal(item.body.qd, "comment/1");
      assert.equal(item.body.card, thread.card.id);
      assert.match(item.at, ISO_WITH_OFFSET);
      assert.ok(item.at >= last, "comments are in time order");
      last = item.at;
      assert.ok(item.body.text.trim());
      if (item.body.options) {
        assert.match(item.body.id ?? "", COMMENT_ID);
        checkOptions(item.body.options, thread.card.id + " comment " + item.body.id);
        assert.ok(item.body.pick_why && item.body.pick_why.length <= BUDGET.pick_why);
      }
    }
  }
});

test("an answer names its card, its pick and its revision, and a pick on a comment names that comment", () => {
  for (const thread of threads) {
    let last = "";
    for (const answer of thread.answers) {
      assert.equal(answer.qd, "answer/1");
      assert.equal(answer.card, thread.card.id);
      assert.match(answer.at, ISO_WITH_OFFSET);
      assert.ok(answer.at >= last, "answers are in time order");
      last = answer.at;
      assert.ok(Number.isInteger(answer.rev) && answer.rev >= 1 && answer.rev <= thread.rev);
      const small = answer.comment === undefined ? undefined : thread.comments.find((item) => item.body.id === answer.comment);
      if (answer.comment !== undefined) assert.ok(small && small.body.options, "the picked comment has options");
      const letters = (small ? small.body.options : thread.card.options ?? []).map((option) => option.label[0]);
      assert.ok(["cant-decide", "none", ...letters].includes(answer.pick));
    }
  }
});

test("posters and senders are bot names or the Captain, and times carry an offset", () => {
  for (const thread of threads) {
    assert.match(thread.from, BOT_NAME);
    assert.match(thread.at, ISO_WITH_OFFSET);
    for (const item of thread.comments) assert.ok(item.from === "Captain" || BOT_NAME.test(item.from));
  }
});

test("no long dash, address, key text or long hex run appears anywhere", () => {
  for (const thread of threads) {
    for (const text of strings(thread)) {
      assert.ok(!/[\u2014\u2013]/.test(text), "long dash in " + text.slice(0, 30));
      assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text), "address in " + text.slice(0, 30));
      assert.ok(!/-----BEGIN|\bsk-[A-Za-z0-9]/.test(text), "key text in " + text.slice(0, 30));
      assert.ok(!/\b[0-9a-f]{12,}\b/i.test(text), "long hex run in " + text.slice(0, 30));
    }
  }
});

test("no typed clock time in a title or an about line", () => {
  for (const { card } of threads) {
    assert.ok(!/\b\d{1,2}:[0-5]\d/.test(card.title + " " + card.about));
  }
});

test("each call returns fresh cards", () => {
  const first = exampleCardThreads();
  first[0].card.title = "changed";
  first[0].comments.length = 0;
  assert.notEqual(exampleCardThreads()[0].card.title, "changed");
  assert.ok(exampleCardThreads()[0].comments.length > 0);
});
