import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { newCount, projectNewCount, anyNew, groupActivity, menuDot } = await loadTs("src/domain/seen.ts");

const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const BOTS = [{ name: "Alba" }, { name: "Shelvorn" }];
const entry = (at, bot = "Alba") => ({ at, bot, text: "x", refs: [] });
const lane = (id, projectId, lastLooked, activity) => ({ id, projectId, lastLooked, activity });

const lanes = () => [
  lane("a", "p1", "2026-11-02T08:30:00-05:00", [entry("2026-11-02T09:12:00-05:00"), entry("2026-11-02T09:05:00-05:00", "Shelvorn"), entry("2026-11-02T08:10:00-05:00")]),
  lane("b", "p1", "2026-11-02T09:00:00-05:00", [entry("2026-11-02T09:50:00-05:00"), entry("2026-11-01T18:20:00-05:00")]),
  lane("c", "p2", "2026-11-02T09:30:00-05:00", [entry("2026-11-02T09:10:00-05:00")]),
];

test("a Lane's count is its Activity entries from a bot strictly after his last look", () => {
  const [a, b, c] = lanes();
  assert.deepEqual([newCount(a, BOTS), newCount(b, BOTS), newCount(c, BOTS)], [2, 1, 0]);
  assert.equal(newCount({ ...c, activity: [entry("2026-11-02T09:30:00-05:00")] }, BOTS), 0);
});

test("a project's count is the sum of its Lanes' counts", () => {
  assert.deepEqual([projectNewCount(lanes(), "p1", BOTS), projectNewCount(lanes(), "p2", BOTS), projectNewCount(lanes(), "p3", BOTS)], [3, 0, 0]);
});

test("opening a Lane clears its count and lowers the project count by it", () => {
  const opened = lanes().map((item) => (item.id === "a" ? { ...item, lastLooked: new Date(NOW).toISOString() } : item));
  assert.deepEqual([newCount(opened[0], BOTS), projectNewCount(opened, "p1", BOTS)], [0, 1]);
});

test("a later bot entry brings the mark back, and a later entry of his own does not", () => {
  const opened = { ...lanes()[0], lastLooked: new Date(NOW).toISOString() };
  const later = { ...opened, activity: [entry("2026-11-02T10:20:00-05:00"), ...opened.activity] };
  assert.equal(newCount(later, BOTS), 1);
  assert.equal(newCount({ ...opened, activity: [entry("2026-11-02T10:20:00-05:00", "Captain"), ...opened.activity] }, BOTS), 0);
});

test("his own entries never count, in the Lane or in the sidebar", () => {
  const own = lane("d", "p3", "2026-11-02T08:00:00-05:00", [entry("2026-11-02T09:00:00-05:00", "Captain"), entry("2026-11-02T09:30:00-05:00", "Captain")]);
  assert.deepEqual([newCount(own, BOTS), anyNew([own], BOTS)], [0, false]);
});

test("the sidebar dot shows while any Lane has a new entry and goes when every Lane is opened", () => {
  assert.equal(anyNew(lanes(), BOTS), true);
  const opened = lanes().map((item) => ({ ...item, lastLooked: new Date(NOW).toISOString() }));
  assert.equal(anyNew(opened, BOTS), false);
});

test("the You last looked line sits between the new entries and the ones he had seen", () => {
  const [a] = lanes();
  const groups = groupActivity(a, a.lastLooked, BOTS, NOW);
  assert.deepEqual([groups.fresh.map((item) => item.at.slice(11, 16)), groups.line, groups.seen.map((item) => item.at.slice(11, 16))], [["09:12", "09:05"], "You last looked: 8:30 AM", ["08:10"]]);
});

test("the line shows the weekday for a look within a week and the date after that", () => {
  const entries = [entry("2026-11-02T09:00:00-05:00")];
  assert.equal(groupActivity(lane("a", "p", "x", entries), "2026-11-01T09:00:00-05:00", BOTS, NOW).line, "You last looked: Sun 9:00 AM");
  assert.equal(groupActivity(lane("a", "p", "x", entries), "2026-10-22T09:00:00-04:00", BOTS, NOW).line, "You last looked: Oct 22, 9:00 AM");
});

test("there is no line when nothing is new", () => {
  const [, , c] = lanes();
  const groups = groupActivity(c, c.lastLooked, BOTS, NOW);
  assert.deepEqual([groups.line, groups.fresh, groups.seen.length], [null, [], 1]);
});

test("a Lane he has never opened counts every bot entry as new and shows no line", () => {
  const never = lane("n", "p3", null, [entry("2026-11-02T09:40:00-05:00"), entry("2026-11-02T07:30:00-05:00", "Captain"), entry("2026-11-01T18:00:00-05:00", "Shelvorn")]);
  assert.equal(newCount(never, BOTS), 2);
  const groups = groupActivity(never, null, BOTS, NOW);
  assert.deepEqual([groups.line, groups.fresh.length, groups.seen.length], [null, 3, 0]);
});

test("the line keeps the old time for the opened Lane even after the look moves on", () => {
  const [a] = lanes();
  const opened = { ...a, lastLooked: new Date(NOW).toISOString() };
  assert.equal(groupActivity(opened, a.lastLooked, BOTS, NOW).line, "You last looked: 8:30 AM");
  assert.equal(groupActivity(opened, opened.lastLooked, BOTS, NOW).line, null);
});

const looked = () => lanes().map((item) => ({ ...item, lastLooked: new Date(NOW).toISOString() }));
const chat = (id, unread) => ({ bot: { id }, unread });

test("the menu dot shows while a Lane has new bot activity, with no chats loaded yet", () => {
  assert.equal(menuDot(lanes(), BOTS, null, null), true);
});

test("the menu dot shows for an unread chat other than the open one", () => {
  assert.equal(menuDot(looked(), BOTS, [chat("iris", false), chat("alba", true)], "iris"), true);
});

test("the menu dot stays off when the only unread chat is the open one and no Lane is new", () => {
  assert.equal(menuDot(looked(), BOTS, [chat("iris", true), chat("alba", false)], "iris"), false);
});
