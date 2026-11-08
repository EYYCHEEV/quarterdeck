import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { viewMail, EMPTY_MAIL_QUERY, botsOrdered, listBots, toLine, ccLine, askChoices, askLabels, otherBots, forwardedFrom, forwardedByLine, dayGroups, removedNames, botsLine, participants, removedNote, removedIn, lastMailAt } = await loadTs("src/domain/mail.ts");

const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const mail = (ref, at, from, to, cc, text, extra = {}) => ({ ref, from, to, cc, at, text, refs: [], ...extra });
const thread = (ref, mails, extra = {}) => ({ ref, subject: "Subject " + ref, projectId: "quarterdeck", laneId: "l-sea", cardId: null, bots: [], mails, ...extra });
const bot = (id, name, order, extra = {}) => ({ id, name, role: "", color: "#ffffff", pinned: false, order, ...extra });

const BOTS = [bot("iris", "Iris", 0), bot("alba", "Alba", 1), bot("dr-kivo", "Dr. Kivo", 2), bot("shelvorn", "Shelvorn", 3), bot("dale", "Dale", 4), bot("pib", "Pib", 5, { removedAt: "2026-11-01T11:00:00-05:00" })];
const REMOVED = removedNames(BOTS);

const WORLD = {
  projects: [
    { id: "quarterdeck", name: "quarterdeck", lead: "Alba", description: "", activeAt: "2026-11-02T09:00:00-05:00" },
    { id: "dale-tools", name: "dale-tools", lead: "Dr. Kivo", description: "", activeAt: "2026-11-02T09:00:00-05:00" },
  ],
  lanes: [
    { id: "l-sea", projectId: "quarterdeck", name: "Search", status: "Active", lead: "", now: "", activity: [] },
    { id: "l-da1", projectId: "dale-tools", name: "Task export", status: "Active", lead: "", now: "", activity: [] },
  ],
  bots: BOTS,
  mail: [
    thread("MT-101", [mail("MT-101.1", "2026-11-02T08:05:00-05:00", "Alba", ["Dr. Kivo"], [], "Try a limit of 5."), mail("MT-101.2", "2026-11-02T09:36:00-05:00", "Iris", ["Alba"], ["Dr. Kivo"], "Add the no-answer line.")]),
    thread("MT-104", [mail("MT-104.1", "2026-11-01T07:55:00-05:00", "Dale", ["Dr. Kivo"], [], "Title, Lane and State.")], { projectId: "dale-tools", laneId: "l-da1" }),
    thread("MT-103", [mail("MT-103.1", "2026-11-02T07:28:00-05:00", "Shelvorn", ["Iris"], ["Pib"], "Email and Log out only.")]),
    thread("MT-105", [mail("MT-105.1", "2026-10-30T16:20:00-05:00", "Pib", ["Dr. Kivo"], [], "Test done.")], { projectId: "dale-tools", laneId: "l-da1" }),
  ],
};
const refs = (view) => view.threads.map((t) => t.ref);
const view = (query = EMPTY_MAIL_QUERY) => viewMail(WORLD, query, NOW);

test("threads list newest last mail first", () => {
  assert.deepEqual(refs(view()), ["MT-101", "MT-103", "MT-104", "MT-105"]);
});

test("search reads subjects, references and every mail's text", () => {
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, text: "no-answer" })), ["MT-101"]);
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, text: "mt-104" })), ["MT-104"]);
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, text: "nothing like this" })), []);
});

test("the count says how many threads show of all of them", () => {
  assert.equal(view().count, "4 threads");
  assert.equal(view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Dale" } }).count, "1 of 4 threads");
  assert.equal(view({ ...EMPTY_MAIL_QUERY, text: "nothing like this" }).count, "0 of 4 threads");
});

test("filters narrow by project, Lane, bot and day, and name themselves with Clear", () => {
  const byBot = view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Dale" } });
  assert.deepEqual(refs(byBot), ["MT-104"]);
  assert.deepEqual(byBot.chips, [{ key: "bot", text: "Bot: Dale" }]);
  assert.equal(byBot.filterCount, 1);
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, filters: { day: "2026-11-01" } })), ["MT-104"]);
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, filters: { project: "quarterdeck", lane: "l-sea" } })), ["MT-101", "MT-103"]);
});

test("the bot filter matches From, To or Cc, and a removed bot keeps its mark in the choices and the chip", () => {
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Dr. Kivo" } })), ["MT-101", "MT-104", "MT-105"]);
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Pib" } })), ["MT-103", "MT-105"]);
  assert.deepEqual(refs(view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Iris" } })), ["MT-101", "MT-103"]);
  const onlyCc = view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Pib" } });
  assert.deepEqual(onlyCc.chips, [{ key: "bot", text: "Bot: Pib (removed)" }]);
});

test("the filter lists come from the mail itself", () => {
  const groups = Object.fromEntries(view().groups.map((g) => [g.key, g.choices.map((c) => c.label)]));
  assert.deepEqual(groups.bot, ["Alba", "Dale", "Dr. Kivo", "Iris", "Pib (removed)", "Shelvorn"]);
  assert.deepEqual(groups.day, ["Mon Nov 2", "Sun Nov 1", "Fri Oct 30"]);
  assert.deepEqual(groups.lane, ["Search", "Task export"]);
});

test("a thread's bots go in order of first appearance: writer, To, then Cc, each mail in turn", () => {
  const first = thread("MT-1", [mail("MT-1.1", "2026-11-02T08:00:00-05:00", "Shelvorn", ["Iris"], ["Alba"], "x"), mail("MT-1.2", "2026-11-02T08:10:00-05:00", "Iris", ["Dr. Kivo"], [], "y")]);
  assert.deepEqual(botsOrdered(first), ["Shelvorn", "Iris", "Alba", "Dr. Kivo"]);
  assert.deepEqual(participants(first.mails[0]), ["Shelvorn", "Iris", "Alba"]);
});

test("the list row shows the first two bots and a plus count for the rest", () => {
  const some = (names) => thread("MT-2", [mail("MT-2.1", "2026-11-02T08:00:00-05:00", names[0], [names[1]], names.slice(2), "x")]);
  assert.deepEqual(listBots(some(["Iris", "Alba"])), { shown: ["Iris", "Alba"], plus: 0, text: "Iris, Alba" });
  assert.equal(listBots(some(["Iris", "Alba", "Dale"])).text, "Iris, Alba +1");
  assert.equal(listBots(some(["Iris", "Alba", "Dale", "Shelvorn", "Dr. Kivo"])).text, "Iris, Alba +3");
});

test("the To line names the writer and every recipient, the Cc line only shows when someone is copied, and a removed bot is marked", () => {
  const [one, two] = [WORLD.mail[0].mails[0], WORLD.mail[0].mails[1]];
  assert.equal(toLine(one, REMOVED), "Alba to Dr. Kivo");
  assert.equal(ccLine(one, REMOVED), null);
  assert.equal(ccLine(two, REMOVED), "cc Dr. Kivo");
  const gone = WORLD.mail[3].mails[0];
  assert.equal(toLine(gone, REMOVED), "Pib (removed) to Dr. Kivo");
  assert.equal(toLine(mail("MT-3.1", "2026-11-02T08:00:00-05:00", "Dr. Kivo", ["Pib", "Iris"], [], "x"), REMOVED), "Dr. Kivo to Pib (removed), Iris");
  assert.equal(ccLine(WORLD.mail[2].mails[0], REMOVED), "cc Pib (removed)");
  assert.equal(botsLine(WORLD.mail[3], REMOVED), "Pib (removed), Dr. Kivo");
});

test("Ask on a mail lists the writer first, then the thread's other bots, never a removed bot, then Another bot", () => {
  const second = WORLD.mail[0];
  assert.deepEqual(askLabels(askChoices(second, second.mails[1], BOTS)), ["Iris (wrote it)", "Alba", "Dr. Kivo", "Another bot..."]);
  const gone = WORLD.mail[3];
  assert.deepEqual(askLabels(askChoices(gone, gone.mails[0], BOTS)), ["Dr. Kivo", "Another bot..."]);
  const replyToGone = thread("MT-4", [mail("MT-4.1", "2026-10-30T09:00:00-05:00", "Dr. Kivo", ["Pib"], [], "x")]);
  assert.deepEqual(askLabels(askChoices(replyToGone, replyToGone.mails[0], BOTS)), ["Dr. Kivo (wrote it)", "Another bot..."]);
});

test("Ask on the thread lists every bot in thread order and marks nobody as the writer", () => {
  const first = WORLD.mail[0];
  const choices = askChoices(first, null, BOTS);
  assert.deepEqual(askLabels(choices), ["Alba", "Dr. Kivo", "Iris", "Another bot..."]);
  assert.ok(choices.every((choice) => !choice.wrote));
  assert.deepEqual(choices.map((choice) => choice.id), ["alba", "dr-kivo", "iris"]);
});

test("Another bot opens the live bots that are not already listed, in the bot order", () => {
  const first = WORLD.mail[0];
  assert.deepEqual(otherBots(askChoices(first, null, BOTS), BOTS).map((b) => b.name), ["Shelvorn", "Dale"]);
  const everyone = thread("MT-5", [mail("MT-5.1", "2026-11-02T08:00:00-05:00", "Iris", ["Alba", "Dr. Kivo"], ["Shelvorn", "Dale"], "x")]);
  assert.deepEqual(otherBots(askChoices(everyone, null, BOTS), BOTS), []);
});

test("on the server a mail names its bots by id, so Ask finds a bot with a display name by its id, reads its name, and an id wins over a name that matches it", () => {
  const bots = [bot("repo-lead", "Repo Lead", 0), bot("bot-a", "Bot A", 1), bot("bot-b", "bot-a", 2)];
  const sent = thread("MT-1", [mail("MT-1.1", "2026-11-02T08:00:00-05:00", "repo-lead", ["account-user"], [], "x"), mail("MT-1.2", "2026-11-02T08:05:00-05:00", "bot-a", ["repo-lead"], [], "y")]);
  const choices = askChoices(sent, sent.mails[0], bots);
  assert.deepEqual(choices.map((choice) => [choice.id, choice.label]), [["repo-lead", "Repo Lead (wrote it)"], ["bot-a", "Bot A"]]);
  assert.deepEqual(otherBots(choices, bots).map((b) => b.id), ["bot-b"]);
});

test("threads group under Today, Yesterday and the weekday and date of an earlier day, in the list's own order", () => {
  const days = view().days;
  assert.deepEqual(days.map((day) => day.heading), ["Today", "Yesterday", "Fri Oct 30"]);
  assert.deepEqual(days.map((day) => day.threads.map((t) => t.ref)), [["MT-101", "MT-103"], ["MT-104"], ["MT-105"]]);
  assert.deepEqual(dayGroups([], NOW, (thread) => thread), []);
  const filtered = view({ ...EMPTY_MAIL_QUERY, filters: { bot: "Pib" } });
  assert.deepEqual(filtered.days.map((day) => day.heading), ["Today", "Fri Oct 30"]);
});

test("a forwarded mail names the mail it came from and quotes its writer, time, text and files", () => {
  const original = mail("MT-101.2", "2026-11-02T08:20:00-05:00", "Dr. Kivo", ["Alba"], [], "Five fits.", { refs: ["AR-2"], forwardedBy: [{ by: "Alba", to: ["Iris"], thread: "MT-106", mail: "MT-106.1" }] });
  const forward = mail("MT-106.1", "2026-11-02T09:52:00-05:00", "Alba", ["Iris"], [], "Please add this to the plan.", { forwardedFrom: { ref: "MT-101.2" } });
  const world = { mail: [thread("MT-101", [original]), thread("MT-106", [forward])] };
  assert.deepEqual(forwardedFrom(world, forward, REMOVED, NOW), { ref: "MT-101.2", line: "Forwarded from MT-101.2", quote: { writerToRecipient: "Dr. Kivo to Alba", time: "8:20 AM", text: "Five fits.", refs: ["AR-2"] } });
  assert.equal(forwardedFrom(world, original, REMOVED, NOW), null);
  assert.equal(forwardedByLine(original.forwardedBy[0], REMOVED), "Forwarded by Alba to Iris in MT-106");
});

test("a forward whose original is missing still names it, and a forward of a forward names only the mail it was forwarded from", () => {
  const lost = mail("MT-9.1", "2026-11-02T09:52:00-05:00", "Alba", ["Iris"], [], "See this.", { forwardedFrom: { ref: "MT-77.1" } });
  assert.deepEqual(forwardedFrom({ mail: [] }, lost, REMOVED, NOW), { ref: "MT-77.1", line: "Forwarded from MT-77.1", quote: null });
  const first = mail("MT-6.1", "2026-11-02T08:00:00-05:00", "Dr. Kivo", ["Alba"], [], "Original.");
  const second = mail("MT-7.1", "2026-11-02T08:30:00-05:00", "Alba", ["Iris"], [], "Second.", { forwardedFrom: { ref: "MT-6.1" } });
  const third = mail("MT-8.1", "2026-11-02T09:00:00-05:00", "Iris", ["Shelvorn"], [], "Third.", { forwardedFrom: { ref: "MT-7.1" } });
  const world = { mail: [thread("MT-6", [first]), thread("MT-7", [second]), thread("MT-8", [third])] };
  const seen = forwardedFrom(world, third, REMOVED, NOW);
  assert.equal(seen.line, "Forwarded from MT-7.1");
  assert.equal(seen.quote.text, "Second.");
});

test("a mail earlier than today quotes with the day it was sent", () => {
  const old = mail("MT-10.1", "2026-11-01T16:05:00-05:00", "Dr. Kivo", ["Alba"], [], "Shipped.");
  const forward = mail("MT-11.1", "2026-11-02T09:00:00-05:00", "Alba", ["Iris"], [], "Look.", { forwardedFrom: { ref: "MT-10.1" } });
  const world = { mail: [thread("MT-10", [old]), thread("MT-11", [forward])] };
  assert.equal(forwardedFrom(world, forward, REMOVED, NOW).quote.time, "Sun 4:05 PM");
});

test("the removed-bot note reads the flow's words for one bot and for two", () => {
  assert.equal(removedNote(["Dale"]), "Mail kept, read only. Dale gets no new mail until it comes back and claims its name. Ask does not list Dale.");
  assert.equal(removedNote(["Dale", "Pib"]), "Mail kept, read only. Dale and Pib get no new mail until they come back and claim their names. Ask does not list Dale or Pib.");
});

test("only a removed bot that sent, received or was copied on the mail counts as in it", () => {
  assert.deepEqual(removedIn(mail("MT-1.1", "2026-11-02T08:00:00-05:00", "Pib", ["Iris"], ["Dale"], "x"), REMOVED), ["Pib"]);
  assert.deepEqual(removedIn(mail("MT-1.2", "2026-11-02T08:00:00-05:00", "Iris", ["Alba"], ["Pib"], "x"), REMOVED), ["Pib"]);
  assert.deepEqual(removedIn(mail("MT-1.3", "2026-11-02T08:00:00-05:00", "Iris", ["Alba"], [], "x"), REMOVED), []);
});

const summary = (lastAt, bots, days, count) => ({ lastAt, bots, days, count });
const SUMMARY_WORLD = {
  projects: WORLD.projects,
  lanes: WORLD.lanes,
  bots: BOTS,
  mail: [
    thread("MT-201", [], { subject: "Recent searches on a phone", summary: summary("2026-11-02T09:52:00-05:00", ["Alba", "Iris", "Dr. Kivo"], ["2026-11-02", "2026-11-01"], 3) }),
    thread("MT-202", [], { subject: "Mail client plan", projectId: "dale-tools", laneId: "l-da1", summary: summary("2026-11-01T14:00:00-05:00", ["Dale"], ["2026-11-01"], 1) }),
  ],
};
const summaryView = (query = EMPTY_MAIL_QUERY, world = SUMMARY_WORLD) => viewMail(world, query, NOW);

test("a thread known only by its summary has its last mail time, its bots and its place in the day groups", () => {
  const [first] = SUMMARY_WORLD.mail;
  assert.equal(lastMailAt(first), Date.parse("2026-11-02T09:52:00-05:00"));
  assert.deepEqual(botsOrdered(first), ["Alba", "Iris", "Dr. Kivo"]);
  assert.deepEqual(listBots(first), { shown: ["Alba", "Iris"], plus: 1, text: "Alba, Iris +1" });
  assert.deepEqual(refs(summaryView()), ["MT-201", "MT-202"]);
  assert.deepEqual(summaryView().days.map((d) => [d.heading, refs(d)]), [["Today", ["MT-201"]], ["Yesterday", ["MT-202"]]]);
});

test("a thread with no summary works from its mails as before", () => {
  assert.equal(lastMailAt(WORLD.mail[0]), Date.parse("2026-11-02T09:36:00-05:00"));
  assert.deepEqual(botsOrdered(WORLD.mail[0]), ["Alba", "Dr. Kivo", "Iris"]);
});

test("the Bot and Date filters, and their choices, read the summary when a thread has no mails loaded", () => {
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, filters: { bot: "Dale" } })), ["MT-202"]);
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, filters: { bot: "Iris" } })), ["MT-201"]);
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, filters: { day: "2026-11-01" } })), ["MT-201", "MT-202"]);
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, filters: { day: "2026-11-02" } })), ["MT-201"]);
  const groups = summaryView().groups;
  assert.deepEqual(groups.find((g) => g.key === "bot").choices.map((c) => c.value), ["Alba", "Dale", "Dr. Kivo", "Iris"]);
  assert.deepEqual(groups.find((g) => g.key === "day").choices, [{ value: "2026-11-02", label: "Mon Nov 2" }, { value: "2026-11-01", label: "Sun Nov 1" }]);
});

test("the search finds a thread by subject or code without its mails, and by mail text once its mails are loaded", () => {
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, text: "phone" })), ["MT-201"]);
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, text: "mt-202" })), ["MT-202"]);
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, text: "check the rows" })), []);
  const loaded = { ...SUMMARY_WORLD, mail: [...SUMMARY_WORLD.mail, thread("MT-203", [mail("MT-203.1", "2026-11-02T08:00:00-05:00", "Iris", ["Alba"], [], "Please check the rows")], { summary: summary("2026-11-02T08:00:00-05:00", ["Iris", "Alba"], ["2026-11-02"], 1) })] };
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, text: "check the rows" }, loaded)), ["MT-203"]);
});

test("a summary speaks for the whole thread when only its newest mails are loaded", () => {
  const partial = thread("MT-204", [mail("MT-204.5", "2026-11-02T08:00:00-05:00", "Iris", ["Alba"], [], "Latest")], { summary: summary("2026-11-02T08:00:00-05:00", ["Alba", "Iris", "Dale"], ["2026-11-02", "2026-11-01"], 5) });
  assert.deepEqual(botsOrdered(partial), ["Alba", "Iris", "Dale"]);
  const world = { ...SUMMARY_WORLD, mail: [partial] };
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, filters: { bot: "Dale" } }, world)), ["MT-204"]);
  assert.deepEqual(refs(summaryView({ ...EMPTY_MAIL_QUERY, filters: { day: "2026-11-01" } }, world)), ["MT-204"]);
});
