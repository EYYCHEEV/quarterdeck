import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { readFileSync } from "node:fs";

const { buildWorld } = await loadTs("src/data/world.ts");
const { exampleCardThreads } = await loadTs("src/data/example-cards.ts");
const { pageCardThreads } = await loadTs("src/data/pages.ts");
const { SHORT_CARDS, EXAMPLE_NOW } = await loadTs("src/data/example-content.ts");
const { rankQueue } = await loadTs("src/domain/queue.ts");
const { cardCheck } = await loadTs("src/domain/card.ts");
const { viewQueue, EMPTY_QUERY } = await loadTs("src/domain/query.ts");
const { botsOrdered, listBots, toLine, ccLine, askChoices, askLabels, viewMail, removedNames, forwardedFrom, forwardedByLine, findMail, lastMailAt, EMPTY_MAIL_QUERY } = await loadTs("src/domain/mail.ts");
const { mailQuote } = await loadTs("src/domain/chat.ts");
const { mailFixture } = await loadTs("src/data/mail-fixture.ts");
const MAIL = JSON.parse(readFileSync(new URL("./mail-content.json", import.meta.url), "utf8"));

const NOW = Date.parse(EXAMPLE_NOW);
const world = () => buildWorld({ threads: [...exampleCardThreads(), ...pageCardThreads()], extras: new Map(), short: SHORT_CARDS, session: { seen: new Map(), answers: new Map(), looked: new Map() }, pages: [] });

const SECTION_11 = [
  ["shelvorn-1", "P0", 4, "2026-11-03T12:00:00-05:00"],
  ["c2", "P0", 2, "2026-11-02T18:00:00-05:00"],
  ["c1", "P1", 2, "2026-11-03T17:00:00-05:00"],
  ["alba-1", "P1", 2, "2026-11-04T17:00:00-05:00"],
  ["shelvorn-2", "P1", 1, "2026-11-03T17:00:00-05:00"],
  ["c6", "P1", 1, "2026-11-04T12:00:00-05:00"],
  ["dr-kivo-1", "P2", 2, "2026-11-05T17:00:00-05:00"],
  ["dr-kivo-2", "P2", 0, "2026-11-05T17:00:00-05:00"],
  ["c9", "P3", 1, "2026-11-09T12:00:00-05:00"],
  ["c4", "P3", 0, "2026-11-06T12:00:00-05:00"],
];

test("the computed Queue equals section 11's table with the make-public card in and the Join card not yet built: 10 waiting, Unblocks counting bot tasks only", () => {
  const w = world();
  const rows = rankQueue(w.cards, w.tasks, NOW);
  assert.deepEqual(
    rows.map((r) => [r.card.id, r.card.priority, r.unblocking.length, Date.parse(r.card.due)]),
    SECTION_11.map(([id, p, n, due]) => [id, p, n, Date.parse(due)]),
  );
  assert.equal(viewQueue(w, EMPTY_QUERY, NOW).count, "10 waiting");
});

function row(rows, id) {
  return rows.find((r) => r.card.id === id);
}

test("the FYI card is gone and no card id counts as a task", () => {
  const w = world();
  assert.equal(w.cards.some((card) => card.id === "alba-2"), false);
  const rows = rankQueue(w.cards, w.tasks, NOW);
  assert.deepEqual(row(rows, "alba-1").unblocking.map((t) => t.title), ["Search pop-up on the phone", "Search ranking notes"]);
  assert.deepEqual(row(rows, "shelvorn-1").unblocking.map((t) => t.id), ["t5", "t6", "t7", "c7"]);
  assert.deepEqual(row(rows, "c2").unblocking.map((t) => t.id), ["t1", "t2"]);
  assert.deepEqual(row(rows, "dr-kivo-1").unblocking.map((t) => t.id), ["t8", "t9"]);
});

test("with the content lead's content merged, every waiting card passes the card check", () => {
  const w = world();
  assert.deepEqual(cardCheck(w.cards.filter((card) => card.answer === null)), []);
});

test("saved versions come in oldest first, and the change trail stays separate", () => {
  const alba = world().cards.find((card) => card.id === "alba-1");
  assert.deepEqual(alba.versions.map((v) => v.version), [1, 2, 3]);
  assert.equal(alba.changes.length, 3);
  assert.equal(alba.versions[1].following, "Put the picture first.");
});

test("the answered card carries his answer, his note and what the bot did", () => {
  const c10 = world().cards.find((card) => card.id === "c10");
  assert.deepEqual(c10.answer.choice, { kind: "option", letter: "B" });
  assert.equal(c10.answer.note, "Light is in now.");
  assert.equal(c10.answer.outcome.by, "Alba");
});

test("an answer to an earlier version is history, not the answer to the waiting version", () => {
  const shelvorn2 = world().cards.find((card) => card.id === "shelvorn-2");
  assert.equal(shelvorn2.answer, null);
  assert.equal(shelvorn2.version, 2);
});

test("evidence follows each card's own references", () => {
  const ev = Object.fromEntries(world().cards.map((card) => [card.id, card.evidence]));
  assert.deepEqual(ev["alba-1"], ["MT-101", "PG-2", "AR-1"]);
  assert.deepEqual([ev["shelvorn-1"], ev.c2, ev["dr-kivo-1"]], [["MT-102"], ["MT-103"], ["MT-104"]]);
  assert.deepEqual([ev.c1, ev.c4, ev.c6, ev.c9, ev["shelvorn-2"]], [[], [], [], [], []]);
});

const allMails = (w) => w.mail.flatMap((thread) => thread.mails);
const refsOf = (view) => view.threads.map((thread) => thread.ref);

test("the example mail merges to the seven threads and nineteen mails mail.json counts", () => {
  const w = world();
  assert.equal(w.mail.length, MAIL.expected.counts.threads);
  assert.equal(allMails(w).length, MAIL.expected.counts.mails);
  assert.deepEqual(w.mail.map((thread) => thread.ref).sort(), Object.keys(MAIL.expected.threads));
});

test("every mail carries the Cc list mail.json adds, and the one fix to MT-101.2 is applied", () => {
  const w = world();
  assert.equal(allMails(w).every((mail) => Array.isArray(mail.cc)), true);
  for (const [ref, cc] of Object.entries(MAIL.ccAdd)) assert.deepEqual(allMails(w).find((mail) => mail.ref === ref).cc, cc, ref);
  assert.deepEqual(allMails(w).find((mail) => mail.ref === "MT-101.2").refs, MAIL.existingMailFixes["MT-101.2"].artifactRefs.now);
  assert.deepEqual(allMails(w).find((mail) => mail.ref === "MT-101.2").forwardedBy, MAIL.forwardedBy["MT-101.2"]);
});

test("the two added threads equal mail.json threadsAdd, and Pib is a removed bot", () => {
  const w = world();
  for (const added of MAIL.threadsAdd) {
    const thread = w.mail.find((item) => item.ref === added.ref);
    assert.deepEqual([thread.subject, thread.projectId, thread.laneId, thread.cardId], [added.subject, added.projectId, added.laneId, added.cardId], added.ref);
    assert.deepEqual(
      thread.mails.map((mail) => [mail.ref, mail.from, mail.to, mail.cc, mail.at, mail.text, mail.refs, mail.forwardedFrom ?? null]),
      added.mails.map((mail) => [mail.ref, mail.from, mail.to, mail.cc, mail.at, mail.text, mail.artifactRefs ?? [], mail.forwardedFrom ?? null]),
      added.ref,
    );
  }
  assert.deepEqual([...removedNames(w.bots)], ["Pib"]);
});

test("bot order, list row, last mail, day heading and the thread Ask list match mail.json", () => {
  const w = world();
  const days = new Map(viewMail(w, EMPTY_MAIL_QUERY, NOW).days.flatMap((day) => day.threads.map((thread) => [thread.ref, day.heading])));
  for (const [ref, want] of Object.entries(MAIL.expected.threads)) {
    const thread = w.mail.find((item) => item.ref === ref);
    assert.deepEqual(botsOrdered(thread), want.botsOrdered, ref);
    assert.equal(botsOrdered(thread).length, want.count, ref);
    assert.deepEqual(listBots(thread), want.listRow, ref);
    assert.equal(lastMailAt(thread), Date.parse(want.lastMailAt), ref);
    assert.equal(days.get(ref), want.dayHeading, ref);
    assert.deepEqual(askLabels(askChoices(thread, null, w.bots)), want.askThread, ref);
  }
});

test("every mail's To line, Cc line, quote header and Ask list match mail.json", () => {
  const w = world();
  const removed = removedNames(w.bots);
  for (const [ref, want] of Object.entries(MAIL.expected.mails)) {
    const { thread, mail } = findMail(w, ref);
    const quote = mailQuote(mail);
    assert.equal(toLine(mail, removed), want.toLine, ref);
    assert.equal(ccLine(mail, removed), want.ccLine, ref);
    assert.equal(quote.label + " " + quote.title, want.quoteHeader, ref);
    assert.deepEqual(askLabels(askChoices(thread, mail, w.bots)), want.ask, ref);
  }
});

test("the list order and day headings match mail.json, and the bot filter matches From, To or Cc", () => {
  const w = world();
  const view = viewMail(w, EMPTY_MAIL_QUERY, NOW);
  assert.deepEqual(view.days.map((day) => ({ heading: day.heading, threads: day.threads.map((thread) => thread.ref) })), MAIL.expected.list);
  for (const [bot, want] of Object.entries(MAIL.expected.botFilter)) {
    const found = viewMail(w, { ...EMPTY_MAIL_QUERY, filters: { bot } }, NOW);
    assert.deepEqual(refsOf(found).sort(), want.threads, bot);
    const viaCc = found.threads.filter((thread) => !thread.mails.some((mail) => mail.from === bot || mail.to.includes(bot))).map((thread) => thread.ref);
    assert.deepEqual(viaCc, want.onlyThroughCc, bot);
  }
});

test("the forward reads Forwarded from and Forwarded by as mail.json gives them, and its thread has no card", () => {
  const w = world();
  const removed = removedNames(w.bots);
  const want = MAIL.expected.forward;
  const original = findMail(w, want.original);
  const forward = findMail(w, want.forwardMail);
  const seen = forwardedFrom(w, forward.mail, removed, NOW);
  assert.equal(seen.line + " >", want.forwardedLine);
  assert.deepEqual({ writerToRecipient: seen.quote.writerToRecipient, time: seen.quote.time, text: seen.quote.text }, want.quoted);
  assert.equal(forwardedByLine(original.mail.forwardedBy[0], removed) + " >", want.originalLine);
  assert.equal(forward.thread.ref, want.forwardThread);
  assert.equal(forward.thread.cardId, null);
});

const FIXTURES = JSON.parse(readFileSync(new URL("./mail-fixtures.json", import.meta.url), "utf8"));
const fixtureWorld = (id) => {
  const source = mailFixture(FIXTURES, id);
  return buildWorld({ threads: exampleCardThreads(), extras: new Map(), short: SHORT_CARDS, session: { seen: new Map(), answers: new Map(), looked: new Map() }, pages: [], mail: source.mail, bots: source.bots });
};

test("fixture MF-1: an empty Cc draws no cc line", () => {
  const w = fixtureWorld("MF-1");
  const { thread, mail } = findMail(w, "MT-901.1");
  const want = FIXTURES.fixtures[0].computed;
  assert.equal(toLine(mail, removedNames(w.bots)), want.toLine);
  assert.equal(ccLine(mail, removedNames(w.bots)), want.ccLine);
  assert.deepEqual(askLabels(askChoices(thread, mail, w.bots)), want.ask);
  assert.equal(listBots(thread).text, "Alba, Shelvorn");
});

test("fixtures MF-2 and MF-4: bot counts read no plus, plus 1, plus 3 and plus 5, and long names stay whole", () => {
  for (const [id, index] of [["MF-2", 1], ["MF-4", 3]]) {
    const w = fixtureWorld(id);
    const computed = FIXTURES.fixtures[index].computed;
    const wanted = computed.botsOrdered ? { [w.mail[0].ref]: computed } : computed;
    for (const [ref, want] of Object.entries(wanted)) {
      const thread = w.mail.find((item) => item.ref === ref);
      assert.deepEqual(botsOrdered(thread), want.botsOrdered, ref);
      assert.deepEqual(listBots(thread), want.listRow, ref);
      assert.deepEqual(askLabels(askChoices(thread, null, w.bots)), want.askThread, ref);
    }
  }
});

test("fixture MF-3: each forward links only to the mail it directly forwards, and each original links forward one step", () => {
  const w = fixtureWorld("MF-3");
  const removed = removedNames(w.bots);
  const third = forwardedFrom(w, findMail(w, "MT-912.1").mail, removed, NOW);
  assert.deepEqual([third.line, third.quote.writerToRecipient, third.quote.time, third.quote.text], ["Forwarded from MT-911.1", "Iris to Shelvorn", "8:30 AM", "Please look at this."]);
  const second = findMail(w, "MT-911.1").mail;
  assert.equal(forwardedFrom(w, second, removed, NOW).line, "Forwarded from MT-910.1");
  assert.deepEqual(second.forwardedBy.map((item) => forwardedByLine(item, removed)), ["Forwarded by Shelvorn to Dr. Kivo in MT-912"]);
  const first = findMail(w, "MT-910.1").mail;
  assert.equal(forwardedFrom(w, first, removed, NOW), null);
  assert.deepEqual(first.forwardedBy.map((item) => forwardedByLine(item, removed)), ["Forwarded by Iris to Shelvorn in MT-911"]);
});

test("fixture MF-5: Iris is only copied on MT-107, and the bot filter still lists it", () => {
  const w = world();
  assert.equal(refsOf(viewMail(w, { ...EMPTY_MAIL_QUERY, filters: { bot: "Iris" } }, NOW)).includes("MT-107"), true);
  assert.equal(findMail(w, "MT-107.1").mail.to.includes("Iris") || findMail(w, "MT-107.1").mail.from === "Iris", false);
});

test("fixtures MF-6 to MF-8: a forward of a removed bot's mail, a mailbox with no mail, and the example with a copy and an Artifact on MT-101.1", () => {
  const removedWorld = fixtureWorld("MF-6");
  const removed = removedNames(removedWorld.bots);
  const original = findMail(removedWorld, "MT-920.1").mail;
  assert.deepEqual(original.forwardedBy.map((item) => forwardedByLine(item, removed)), ["Forwarded by Dr. Kivo to Dale in MT-920"]);
  assert.equal(forwardedFrom(removedWorld, findMail(removedWorld, "MT-920.2").mail, removed, NOW).line, "Forwarded from MT-920.1");
  assert.equal(toLine(original, removed), "Pib (removed) to Dr. Kivo");
  assert.deepEqual(fixtureWorld("MF-7").mail, []);
  const example = fixtureWorld("MF-8");
  assert.deepEqual(example.mail.map((item) => item.ref), world().mail.map((item) => item.ref));
  const first = findMail(example, "MT-101.1").mail;
  assert.deepEqual([first.cc, first.refs], [["Iris"], ["AR-4"]]);
});
