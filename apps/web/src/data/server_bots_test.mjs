import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const load = async () => {
  const { loadTs } = await import("../../tools/load-ts.mjs");
  return loadTs("src/data/server-bots.ts");
};

const sample = (name) => JSON.parse(fs.readFileSync(new URL("./server-payloads/bots/" + name, import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-05T12:00:00Z");
const FRESH = NOW / 1000 + 600;
const STEP_UP = "/captain/step-up?next=/settings/bots";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ticks = async (n = 8) => {
  for (let step = 0; step < n; step += 1) await tick();
};

const json = (body, status = 200) => () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (n, change = (raw) => raw) => json(change({ ...sample("list-200.json"), csrf: "t-list-" + n, freshUntil: FRESH }));
const done = (n) => json({ ...sample("action-200.json"), csrf: "t-done-" + n, freshUntil: FRESH });

function host(...steps) {
  const calls = [];
  const went = [];
  const timers = [];
  let now = NOW;
  const held = [];
  const call = async (meta, path, init) => {
    calls.push({ meta, path, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect });
    const step = steps.shift();
    if (!step) throw new Error("no answer scripted for " + init.method + " " + path);
    if (step === "hold") return new Promise((resolve) => held.push(resolve));
    return step();
  };
  const schedule = (run, delay) => {
    const timer = { at: now + delay, run, live: true };
    timers.push(timer);
    return () => (timer.live = false);
  };
  const advance = (ms) => {
    now += ms;
    for (const timer of timers.filter((one) => one.live && one.at <= now)) {
      timer.live = false;
      timer.run();
    }
  };
  return { host: { call, clock: () => now, schedule, goTo: (path) => went.push(path) }, calls, went, advance, held, more: (...next) => steps.push(...next) };
}

function newestOnly() {
  let given = 0;
  let newest = null;
  const give = () => (newest = "t-" + (given += 1));
  const calls = [];
  const call = async (meta, path, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const seen = { path, method: init.method, body, status: 200 };
    calls.push(seen);
    if (init.method === "GET") return json({ ...sample("list-200.json"), csrf: give(), freshUntil: FRESH })();
    if (body.csrf !== newest) {
      seen.status = 403;
      return json({ error: "request refused" }, 403)();
    }
    newest = null;
    return json({ ...sample(path.endsWith("/invites") ? "invite-200.json" : "action-200.json"), csrf: give(), freshUntil: FRESH })();
  };
  return { host: { call, clock: () => NOW, schedule: () => () => undefined, goTo: () => undefined }, calls, otherRead: give };
}

async function ready(h) {
  const { createServerBots } = await load();
  const part = createServerBots(h.host);
  const seen = [];
  const stop = part.api.subscribe(() => seen.push(part.api.current()));
  await tick();
  await tick();
  return { part, api: part.api, seen, stop };
}

const shape = (calls) => calls.map((call) => call.method + " " + call.path);

test("opening the Bots screen reads the list once and shows it as the screen wants it: the code in two groups, you for the Captain, its time, its end", async () => {
  const h = host(list(1));
  const { api } = await ready(h);
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots"]);
  assert.equal(h.calls[0].meta.kind, "bots");
  const admin = api.current();
  assert.equal(admin.state, "ready");
  assert.equal(admin.approveHere, false);
  assert.deepEqual(admin.pending[0], { id: "K7P42Q9M", name: "tarn", invitedBy: "you", at: "6:58 AM", code: "K7P4 2Q9M", inviteId: null, endsAt: "2026-11-05T07:08:00-05:00" });
  assert.equal(admin.pending[1].invitedBy, "fern");
  assert.deepEqual(admin.invites.map((one) => [one.id, one.forName, one.by, one.endsAt]), [["inv-12charsxx", "tarn", "you", "2026-11-06T06:05:00-05:00"], ["inv-anybot001", null, "fern", "2026-11-05T09:30:00-05:00"]]);
  assert.deepEqual(admin.joined.map((bot) => [bot.id, bot.name]), [["iris", "iris"], ["alba", "alba"], ["dale", "dale"]]);
  assert.equal(admin.notice, null);
  assert.equal(admin.busy, false);
  assert.equal(api.current(), admin, "the same snapshot until something changes");
});

test("the list's answer sets the state: 404 and a page that is not JSON say the approval app, a 503 or an unreadable list says failed, and Try again reads it again", async () => {
  for (const [answer, state] of [[json('{"error":"not found"}', 404), "approval"], [json("<!doctype html><p>app</p>", 200), "approval"], [json("", 405), "approval"], [json('{"error":"request unavailable"}', 503), "failed"], [json({ pending: [] }), "failed"], [() => { throw new TypeError("Failed to fetch"); }, "failed"]]) {
    const h = host(answer, list(2));
    const { api } = await ready(h);
    assert.equal(api.current().state, state, String(answer));
    api.reload();
    await tick();
    await tick();
    assert.equal(api.current().state, "ready");
    assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots"]);
  }
});

test("Refuse reads the list after the tap and sends the code without its space with that read's token, then reads the list again and shows that read; Cancel does the same, and no token from a list or a receipt is held", async () => {
  const h = host(list(1), list(2), done(1), list(3, (raw) => ({ ...raw, pending: raw.pending.slice(1) })), list(4), done(2), list(5));
  const { api } = await ready(h);
  await api.refuseJoin("K7P42Q9M");
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots"]);
  assert.deepEqual(h.calls[2].body, { code: "K7P42Q9M", csrf: "t-list-2" });
  assert.equal(h.calls[2].meta.kind, "post");
  assert.equal(h.calls[2].redirect, "manual");
  assert.deepEqual(api.current().pending.map((one) => one.id), ["M3X85T2R"]);
  await api.cancelInvite("inv-12charsxx");
  assert.deepEqual(h.calls[5].body, { id: "inv-12charsxx", csrf: "t-list-4" });
  assert.deepEqual(h.calls.filter((call) => call.method === "POST").map((call) => call.body.csrf), ["t-list-2", "t-list-4"], "each POST carries the token of the read just before it");
});

test("the token comes only from a list read after the tap: with another read between the bots list and the tap, and a server that takes only the newest token it gave, Refuse, Create invite and Cancel invite are each taken", async () => {
  const server = newestOnly();
  const { api } = await ready(server);
  server.otherRead();
  await api.refuseJoin("K7P42Q9M");
  server.otherRead();
  const made = await api.createInvite("tarn");
  server.otherRead();
  await api.cancelInvite("inv-12charsxx");
  const GET = "GET /captain/api/bots 200";
  assert.deepEqual(server.calls.map((call) => call.method + " " + call.path + " " + call.status), [GET, GET, "POST /captain/api/bots/refuse 200", GET, GET, "POST /captain/api/bots/invites 200", GET, GET, "POST /captain/api/bots/invites/cancel 200", GET]);
  assert.equal(made?.code, "QD7F3K92QM");
  assert.deepEqual([api.current().state, api.current().notice, api.current().busy], ["ready", null, false]);
});

test("a list read out when he taps is not used for the token: the action reads the list in full and posts that read's token, and the late read changes nothing", async () => {
  const h = host(list(1), "hold", list(2), done(1), list(3, (raw) => ({ ...raw, pending: raw.pending.slice(1) })));
  const { api, seen } = await ready(h);
  const late = api.reload();
  await ticks();
  const acted = api.refuseJoin("K7P42Q9M");
  await ticks();
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse"]);
  assert.deepEqual(h.calls[3].body, { code: "K7P42Q9M", csrf: "t-list-2" });
  const from = seen.length;
  h.held[0](list(9, (raw) => ({ ...raw, pending: [] }))());
  await late;
  await acted;
  assert.deepEqual(shape(h.calls).slice(4), ["GET /captain/api/bots"]);
  assert.equal(seen.slice(from).some((one) => one.pending.length === 0), false, "the late read was never shown");
  assert.deepEqual(api.current().pending.map((one) => one.id), ["M3X85T2R"]);
});

test("a failed token read sends no POST: a 503 says Could not do that. with Try again, which reads again and sends; a 404 shows the the approval app line; a 401 ends quietly", async () => {
  const { BOTS_WORDS } = await (await import("../../tools/load-ts.mjs")).loadTs("src/data/bots-client.ts");
  const h = host(list(1), json({ error: "request unavailable" }, 503));
  const { api } = await ready(h);
  await api.refuseJoin("K7P42Q9M");
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots"]);
  assert.deepEqual([api.current().notice, api.current().busy, api.current().pending.length], [{ words: BOTS_WORDS.failed, again: true }, false, 2]);
  h.more(list(2), done(1), list(3));
  await api.again();
  assert.deepEqual(shape(h.calls).slice(2), ["GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots"]);
  assert.deepEqual(h.calls[3].body, { code: "K7P42Q9M", csrf: "t-list-2" });
  for (const [answer, state] of [[json({ error: "not found" }, 404), "approval"], [json({ error: "session" }, 401), "ready"]]) {
    const one = host(list(1), answer);
    const opened = await ready(one);
    await opened.api.refuseJoin("K7P42Q9M");
    assert.deepEqual(shape(one.calls), ["GET /captain/api/bots", "GET /captain/api/bots"]);
    assert.deepEqual([opened.api.current().state, opened.api.current().notice, opened.api.current().busy], [state, null, false]);
  }
});

test("a failed action reads the list again and shows its words: gone shows the new list, and a plain failure offers Try again, which sends it once more", async () => {
  const { BOTS_WORDS } = await (await import("../../tools/load-ts.mjs")).loadTs("src/data/bots-client.ts");
  const h = host(list(1), list(2), json({ error: "gone" }, 404), list(3, (raw) => ({ ...raw, pending: raw.pending.slice(1) })));
  const { api } = await ready(h);
  await api.refuseJoin("K7P42Q9M");
  assert.deepEqual(shape(h.calls).slice(1), ["GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots"]);
  assert.deepEqual(api.current().notice, { words: BOTS_WORDS.gone, again: false });
  assert.deepEqual(api.current().pending.map((one) => one.id), ["M3X85T2R"]);
  h.more(list(4), json({ error: "request unavailable" }, 503), list(5), list(6), done(1), list(7));
  await api.refuseJoin("M3X85T2R");
  assert.deepEqual(api.current().notice, { words: BOTS_WORDS.failed, again: true });
  await api.again();
  assert.deepEqual(shape(h.calls).slice(4), ["GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots"]);
  assert.deepEqual(h.calls[8].body, { code: "M3X85T2R", csrf: "t-list-6" });
  assert.equal(api.current().notice, null);
});

test("one action at a time: a second tap while one is out sends nothing, and the screen knows it is busy", async () => {
  const h = host(list(1), list(2), "hold");
  const { api } = await ready(h);
  const first = api.refuseJoin("K7P42Q9M");
  await tick();
  assert.equal(api.current().busy, true);
  await api.cancelInvite("inv-12charsxx");
  await api.refuseJoin("M3X85T2R");
  await ticks();
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse"]);
  h.more(list(3));
  h.held[0](done(1)());
  await first;
  assert.equal(api.current().busy, false);
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots"]);
});

test("with under 30 s of fresh sign-in left nothing is sent and he goes to the fresh sign-in; with more the action goes; a token read whose fresh sign-in has under 30 s left sends no POST and goes there too", async () => {
  const short = host(list(1, (raw) => ({ ...raw, freshUntil: NOW / 1000 + 29 })));
  const { api } = await ready(short);
  await api.refuseJoin("K7P42Q9M");
  await api.createInvite("tarn");
  assert.deepEqual(shape(short.calls), ["GET /captain/api/bots"]);
  assert.deepEqual(short.went, [STEP_UP, STEP_UP]);
  const enough = host(list(1, (raw) => ({ ...raw, freshUntil: NOW / 1000 + 31 })), list(2, (raw) => ({ ...raw, freshUntil: NOW / 1000 + 31 })), done(1), list(3));
  const ok = await ready(enough);
  await ok.api.refuseJoin("K7P42Q9M");
  assert.deepEqual(shape(enough.calls), ["GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse", "GET /captain/api/bots"]);
  assert.deepEqual(enough.went, []);
  const late = host(list(1), list(2, (raw) => ({ ...raw, freshUntil: NOW / 1000 + 29 })));
  const lapsed = await ready(late);
  await lapsed.api.refuseJoin("K7P42Q9M");
  assert.deepEqual([shape(late.calls), late.went, lapsed.api.current().busy], [["GET /captain/api/bots", "GET /captain/api/bots"], [STEP_UP], false]);
});

test("a 303 on an action goes to the fresh sign-in with next=/settings/bots and reads nothing more; a 401 or 403 reads nothing more", async () => {
  for (const [answer, went] of [[() => new Response(null, { status: 303, headers: { Location: "/captain/step-up?next=%2Fsettings%2Fbots" } }), [STEP_UP]], [json({ error: "session" }, 401), []], [json({ error: "request refused" }, 403), []]]) {
    const h = host(list(1), list(2), answer);
    const { api } = await ready(h);
    await api.refuseJoin("K7P42Q9M");
    assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots", "POST /captain/api/bots/refuse"]);
    assert.deepEqual(h.went, went);
  }
});

test("a request drops from the list when its end passes, with no read", async () => {
  const h = host(list(1));
  const { api, seen } = await ready(h);
  assert.equal(api.current().pending.length, 2);
  const before = seen.length;
  h.advance(59_000);
  assert.equal(api.current().pending.length, 2);
  h.advance(1_000);
  assert.deepEqual(api.current().pending.map((one) => one.id), ["K7P42Q9M"]);
  assert.equal(seen.length > before, true, "the screen is told");
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots"]);
});

test("Create invite checks the name first, then gives back the invite, its code and its prompt once, keeping neither in the list", async () => {
  const { BOTS_WORDS } = await (await import("../../tools/load-ts.mjs")).loadTs("src/data/bots-client.ts");
  const h = host(list(1), list(2), json({ ...sample("invite-200.json"), csrf: "t-done-1", freshUntil: FRESH }), list(3));
  const { api } = await ready(h);
  assert.equal(await api.createInvite("Tarn"), null);
  assert.deepEqual(api.current().notice, { words: BOTS_WORDS.name, again: false });
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots"]);
  const made = await api.createInvite(" tarn ");
  assert.deepEqual(h.calls[2].body, { forName: "tarn", csrf: "t-list-2" });
  assert.deepEqual(made, { invite: { id: "inv-newtarn01", forName: "tarn", by: "you", ends: "", endsAt: "2026-11-06T07:00:00-05:00" }, code: "QD7F3K92QM", prompt: sample("invite-200.json").prompt });
  assert.equal(api.current().notice, null);
  const kept = JSON.stringify(api.current());
  assert.equal(kept.includes("QD7F3K92QM") || kept.includes("Join Quarterdeck"), false, "neither the code nor the prompt is kept");
  h.more(list(4), json({ error: "name" }, 422), list(5), list(6), json({ error: "rate" }, 429), list(7));
  assert.equal(await api.createInvite(""), null);
  assert.deepEqual([h.calls[5].body, api.current().notice], [{ forName: null, csrf: "t-list-4" }, { words: BOTS_WORDS.name, again: false }]);
  assert.equal(await api.createInvite("tarn"), null);
  assert.deepEqual(api.current().notice, { words: BOTS_WORDS.rate, again: false });
});

test("signing out clears the list, an answer from before it is dropped, and a token read out when he signs out sends no POST", async () => {
  const h = host(list(1), "hold");
  const { part, api } = await ready(h);
  part.clear();
  assert.equal(api.current().state, "loading");
  assert.equal(api.current().pending.length, 0);
  const h2 = host(list(1), "hold");
  const again = await ready(h2);
  const reading = again.api.reload();
  await tick();
  again.part.clear();
  h2.held[0](list(9)());
  await reading;
  assert.equal(again.api.current().state, "loading");
  assert.equal(JSON.stringify(again.api.current()).includes("tarn"), false);
  const h3 = host(list(1), "hold");
  const third = await ready(h3);
  const acting = third.api.refuseJoin("K7P42Q9M");
  await ticks();
  third.part.clear();
  h3.held[0](list(2)());
  await acting;
  assert.deepEqual([shape(h3.calls), third.api.current().state, third.api.current().busy], [["GET /captain/api/bots", "GET /captain/api/bots"], "loading", false]);
});

test("coming back to the screen reads the list again", async () => {
  const h = host(list(1), list(2));
  const { api, stop } = await ready(h);
  stop();
  const stopAgain = api.subscribe(() => undefined);
  await tick();
  await tick();
  assert.deepEqual(shape(h.calls), ["GET /captain/api/bots", "GET /captain/api/bots"]);
  stopAgain();
});
