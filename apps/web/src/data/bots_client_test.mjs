import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const load = async () => {
  const { loadTs } = await import("../../tools/load-ts.mjs");
  return loadTs("src/data/bots-client.ts");
};

const sample = (name) => JSON.parse(fs.readFileSync(new URL("./server-payloads/bots/" + name, import.meta.url), "utf8"));
const text = (name) => JSON.stringify(sample(name));
const named = (name) => (error) => error?.name === name;
const unreadable = (error) => error?.name === "Refused" && error.message.startsWith("The server's answer could not be read");
const NOW = Date.parse("2026-11-05T12:00:00Z");

test("the r4 list reads to what the screen needs: each part kept, approveHere false, the token and the fresh sign-in time", async () => {
  const { readBotsList } = await load();
  const listing = readBotsList(200, text("list-200.json"));
  assert.deepEqual(listing, sample("list-200.json"));
  assert.equal("password" in listing, false);
});

test("a list field the contract does not name is dropped, at the top and in each row", async () => {
  const { readBotsList } = await load();
  const raw = sample("list-200.json");
  raw.password = true;
  raw.pending[0].extra = 1;
  raw.invites[0].secret = "x";
  raw.joined[0].role = "Lead";
  const listing = readBotsList(200, JSON.stringify(raw));
  assert.deepEqual(listing, sample("list-200.json"));
});

test("a list with a bad field cannot be read: the code, a name, forName, a time, approveHere, the token or freshUntil", async () => {
  const { readBotsList } = await load();
  const bad = (change, label) => {
    const raw = sample("list-200.json");
    change(raw);
    assert.throws(() => readBotsList(200, JSON.stringify(raw)), unreadable, label);
  };
  for (const code of ["K7P42Q9", "K7P42Q9MX", "k7p42q9m", "K7P4 2Q9M", "K7P42Q9O", "K7P42Q91", 5]) bad((raw) => (raw.pending[0].code = code), "code " + code);
  for (const forName of ["Tarn", "9tarn", "tarn_bot", "a".repeat(33), "", 7]) bad((raw) => (raw.invites[0].forName = forName), "forName " + forName);
  for (const time of ["2026-11-05T07:08:00", "soon", "", null]) bad((raw) => (raw.pending[0].ends = time), "ends " + time);
  bad((raw) => (raw.pending[0].at = "07:00"), "at with no date");
  bad((raw) => (raw.invites[0].ends = "tomorrow"), "an invite end that is not a time");
  bad((raw) => (raw.pending[0].name = ""), "an empty name");
  bad((raw) => (raw.pending[0].name = "two\nlines"), "a name on two lines");
  bad((raw) => (raw.pending[0].invitedBy = 3), "invitedBy not text");
  bad((raw) => (raw.invites[0].by = ""), "an empty by");
  bad((raw) => (raw.invites[0].id = "has space"), "an invite id with a space");
  bad((raw) => (raw.joined[0].id = ""), "an empty bot id");
  bad((raw) => (raw.joined[0].name = ""), "an empty bot name");
  bad((raw) => (raw.approveHere = "false"), "approveHere not a boolean");
  bad((raw) => delete raw.approveHere, "no approveHere");
  bad((raw) => (raw.csrf = ""), "an empty token");
  bad((raw) => delete raw.csrf, "no token");
  for (const fresh of ["0", null, Number.NaN]) bad((raw) => (raw.freshUntil = fresh), "freshUntil " + String(fresh));
  bad((raw) => (raw.pending = {}), "pending not a list");
  bad((raw) => delete raw.invites, "no invites");
  bad((raw) => (raw.joined = null), "joined not a list");
});

test("the list answers that mean the server has no bots routes yet read as null: 404, 405, and any 200 that is not JSON", async () => {
  const { readBotsList } = await load();
  assert.equal(readBotsList(404, '{"error":"not found"}'), null);
  assert.equal(readBotsList(405, ""), null);
  assert.equal(readBotsList(200, "<!doctype html><html><body>Quarterdeck</body></html>"), null);
  assert.equal(readBotsList(200, ""), null);
});

test("a signed-out list is SignInRequired, and a 503, a 500 or a 400 is a plain failure", async () => {
  const { readBotsList } = await load();
  for (const status of [401, 403]) assert.throws(() => readBotsList(status, '{"error":"session"}'), named("SignInRequired"), String(status));
  for (const status of [503, 500, 400, 429]) assert.throws(() => readBotsList(status, '{"error":"request unavailable"}'), named("NotConfirmed"), String(status));
  assert.throws(() => readBotsList(200, "[]"), unreadable, "a list that is an array");
});

test("each action body holds exactly its fields, and the code goes back without its space", async () => {
  const { refuseBody, inviteBody, cancelBody } = await load();
  assert.deepEqual(JSON.parse(refuseBody("K7P4 2Q9M", "t1")), { code: "K7P42Q9M", csrf: "t1" });
  assert.deepEqual(Object.keys(JSON.parse(refuseBody("K7P42Q9M", "t1"))), ["code", "csrf"]);
  assert.deepEqual(JSON.parse(inviteBody("tarn", "t2")), { forName: "tarn", csrf: "t2" });
  assert.deepEqual(JSON.parse(inviteBody(null, "t2")), { forName: null, csrf: "t2" });
  assert.deepEqual(Object.keys(JSON.parse(inviteBody(null, "t2"))), ["forName", "csrf"]);
  assert.deepEqual(JSON.parse(cancelBody("inv-12charsxx", "t3")), { id: "inv-12charsxx", csrf: "t3" });
  for (const csrf of ["", null, undefined]) assert.throws(() => refuseBody("K7P42Q9M", csrf), named("Refused"), String(csrf));
});

test("a typed name is checked against Backchannel's rule before anything is sent, and an empty name means any bot", async () => {
  const { forNameOf, BOTS_WORDS } = await load();
  assert.equal(forNameOf(""), null);
  assert.equal(forNameOf("   "), null);
  assert.equal(forNameOf("tarn"), "tarn");
  assert.equal(forNameOf(" tarn-2 "), "tarn-2");
  assert.equal(forNameOf("a" + "b".repeat(31)), "a" + "b".repeat(31));
  for (const name of ["Tarn", "9tarn", "tarn_bot", "a".repeat(33), "-tarn", "tar n", "brïx"]) assert.throws(() => forNameOf(name), (error) => error?.name === "Refused" && error.message === BOTS_WORDS.name, name);
});

test("each action answer gives its words: 303 a fresh sign-in, 401 and 403 signed out, gone, name and rate their own words, and the rest a plain failure", async () => {
  const { readAction, BOTS_WORDS } = await load();
  const refused = (words) => (error) => error?.name === "Refused" && error.message === words;
  assert.throws(() => readAction("refuse", 303, ""), named("FreshSignInRequired"));
  for (const status of [401, 403]) for (const path of ["refuse", "invite", "cancel"]) assert.throws(() => readAction(path, status, '{"error":"session"}'), named("SignInRequired"), path + " " + status);
  assert.throws(() => readAction("refuse", 404, '{"error":"gone"}'), refused(BOTS_WORDS.gone));
  assert.throws(() => readAction("cancel", 404, '{"error":"gone"}'), refused(BOTS_WORDS.inviteGone));
  assert.throws(() => readAction("invite", 422, '{"error":"name"}'), refused(BOTS_WORDS.name));
  for (const path of ["refuse", "invite", "cancel"]) assert.throws(() => readAction(path, 429, '{"error":"rate"}'), refused(BOTS_WORDS.rate), path);
  for (const [path, status, body] of [["refuse", 400, '{"error":"request refused"}'], ["invite", 503, '{"error":"request unavailable"}'], ["refuse", 404, '{"error":"not found"}'], ["cancel", 500, ""], ["invite", 200, "not json"], ["refuse", 200, '{"csrf":""}'], ["invite", 200, text("action-200.json")]]) {
    assert.throws(() => readAction(path, status, body), named("NotConfirmed"), path + " " + status + " " + body);
  }
});

test("a done action gives the new token and fresh sign-in time, and a done invite also gives the invite, its code and its prompt", async () => {
  const { readAction } = await load();
  assert.deepEqual(readAction("refuse", 200, text("action-200.json")), { csrf: "csrf-placeholder", freshUntil: 0 });
  assert.deepEqual(readAction("cancel", 200, JSON.stringify({ ...sample("action-200.json"), more: 1 })), { csrf: "csrf-placeholder", freshUntil: 0 });
  assert.deepEqual(readAction("invite", 200, text("invite-200.json")), sample("invite-200.json"));
  for (const change of [{ code: "" }, { prompt: "" }, { invite: { id: "inv-newtarn01", forName: "Tarn", ends: "2026-11-06T07:00:00-05:00" } }, { invite: null }]) {
    assert.throws(() => readAction("invite", 200, JSON.stringify({ ...sample("invite-200.json"), ...change })), named("NotConfirmed"), JSON.stringify(change));
  }
});

test("the code shows in two groups of four, and the time left reads in minutes, then hours, and under a minute at the end", async () => {
  const { spacedCode, endsText } = await load();
  assert.equal(spacedCode("K7P42Q9M"), "K7P4 2Q9M");
  const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
  assert.equal(endsText(at(8), NOW), "ends in 8 min");
  assert.equal(endsText(at(7.2), NOW), "ends in 8 min");
  assert.equal(endsText(at(1), NOW), "ends in 1 min");
  assert.equal(endsText(at(0.5), NOW), "ends in under a minute");
  assert.equal(endsText(at(59), NOW), "ends in 59 min");
  assert.equal(endsText(at(60), NOW), "ends in 1 h");
  assert.equal(endsText(at(23 * 60 + 59), NOW), "ends in 23 h");
  assert.equal(endsText(at(-1), NOW), "ended");
});
