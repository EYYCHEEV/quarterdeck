import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const time = await loadTs("src/domain/time.ts");
const NOW = Date.parse("2026-11-02T10:00:00-05:00");

test("clock time is the ET hour and minute", () => {
  assert.equal(time.clockTime("2026-11-02T09:40:00-05:00"), "9:40 AM");
  assert.equal(time.clockTime("2026-11-02T04:30:00Z"), "11:30 PM");
});

test("a row's due shows the weekday and the hour, minutes only when not on the hour", () => {
  assert.equal(time.dueShort("2026-11-03T12:00:00-05:00"), "Tue 12 PM");
  assert.equal(time.dueShort("2026-11-02T18:00:00-05:00"), "Mon 6 PM");
  assert.equal(time.dueShort("2026-11-05T17:30:00-05:00"), "Thu 5:30 PM");
});

test("a card's due names the full date in ET and the time left", () => {
  assert.equal(time.dueLong("2026-11-04T17:00:00-05:00", NOW), "Wed Nov 4, 5 PM ET, in 2 days");
  assert.equal(time.dueLong("2026-11-02T18:00:00-05:00", NOW), "Mon Nov 2, 6 PM ET, in 8 hours");
  assert.equal(time.dueLong("2026-11-02T09:00:00-05:00", NOW), "Mon Nov 2, 9 AM ET, past due");
});

test("a row's due is red only once it has passed", () => {
  assert.equal(time.isPastDue("2026-11-02T09:00:00-05:00", NOW), true);
  assert.equal(time.isPastDue("2026-11-02T10:45:00-05:00", NOW), false);
  assert.equal(time.isPastDue(null, NOW), false);
});

test("the card's owner line turns red when the due has passed or is under an hour away", () => {
  assert.equal(time.isDueSoon("2026-11-02T09:00:00-05:00", NOW), true);
  assert.equal(time.isDueSoon("2026-11-02T10:45:00-05:00", NOW), true);
  assert.equal(time.isDueSoon("2026-11-02T11:00:00-05:00", NOW), false);
  assert.equal(time.isDueSoon(null, NOW), false);
});

test("list stamps read as a time today, Yesterday, or a short date", () => {
  assert.equal(time.listStamp("2026-11-02T08:55:00-05:00", NOW), "8:55 AM");
  assert.equal(time.listStamp("2026-11-01T08:00:00-05:00", NOW), "Yesterday");
  assert.equal(time.listStamp("2026-10-29T10:00:00-05:00", NOW), "Oct 29");
});

test("when text is a clock time today, a weekday within 7 days, and a date after that", () => {
  assert.equal(time.whenText("2026-11-02T09:05:00-05:00", NOW), "9:05 AM");
  assert.equal(time.whenText("2026-11-01T16:00:00-05:00", NOW), "Sun 4:00 PM");
  assert.equal(time.whenText("2026-10-30T12:00:00-04:00", NOW), "Fri 12:00 PM");
  assert.equal(time.whenText("2026-10-27T10:00:00-04:00", NOW), "Tue 10:00 AM");
  assert.equal(time.whenText("2026-10-26T10:00:00-04:00", NOW), "Oct 26, 10:00 AM");
  assert.equal(time.whenText("2026-10-21T12:00:00-04:00", NOW), "Oct 21, 12:00 PM");
});

test("when text reads the New York clock, in daylight and standard time", () => {
  assert.equal(time.whenText("2026-10-30T16:00:00Z", NOW), "Fri 12:00 PM");
  assert.equal(time.whenText("2026-11-01T21:00:00Z", NOW), "Sun 4:00 PM");
});

test("due buckets sort a due into overdue, today, this week or none", () => {
  assert.equal(time.dueBucket("2026-11-02T09:00:00-05:00", NOW), "overdue");
  assert.equal(time.dueBucket("2026-11-02T18:00:00-05:00", NOW), "today");
  assert.equal(time.dueBucket("2026-11-05T17:00:00-05:00", NOW), "week");
  assert.equal(time.dueBucket("2026-11-12T17:00:00-05:00", NOW), "later");
  assert.equal(time.dueBucket(null, NOW), "none");
});

test("a Page's age reads minutes, hours, Yesterday, a weekday or a short date, counted on the New York day", () => {
  assert.equal(time.agoText("2026-11-02T09:59:40-05:00", NOW), "just now");
  assert.equal(time.agoText("2026-11-02T09:58:00-05:00", NOW), "2m ago");
  assert.equal(time.agoText("2026-11-02T09:35:00-05:00", NOW), "25m ago");
  assert.equal(time.agoText("2026-11-02T07:00:00-05:00", NOW), "3h ago");
  assert.equal(time.agoText("2026-11-01T16:00:00-05:00", NOW), "Yesterday");
  assert.equal(time.agoText("2026-10-30T12:00:00-04:00", NOW), "Fri");
  assert.equal(time.agoText("2026-10-21T12:00:00-04:00", NOW), "Oct 21");
});

test("an age under an hour counts across midnight, and a time after now reads just now", () => {
  const nearMidnight = Date.parse("2026-11-03T00:10:00-05:00");
  assert.equal(time.agoText("2026-11-02T23:50:00-05:00", nearMidnight), "20m ago");
  assert.equal(time.agoText("2026-11-02T11:00:00-05:00", NOW), "just now");
});
