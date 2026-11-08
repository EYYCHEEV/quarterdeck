import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true" }, loader: { ".html": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createSecretStandIn } = await load("src/data/secret-standin.ts");
const { createExampleData } = await load("src/data/example-data.ts");
const { lazySecrets } = await load("src/data/lazy-parts.ts");
const { SECRET_TEXT, secretText } = await load("src/domain/secrets.ts");

const START = Date.parse("2026-11-02T10:00:00-05:00");
const BOTS = [
  { id: "alba", name: "Alba" },
  { id: "iris", name: "Iris" },
];
const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const VALUE = "ghp_" + Array.from({ length: 36 }, (_, i) => CHARS[(i * 17 + (i * i) % 11 + 3) % CHARS.length]).join("");
const CANARY = Array.from({ length: 32 }, (_, at) => String.fromCharCode(0xe000 + at)).join("");
const stamp = (ms) => new Date(ms).toISOString();

const arrived = (secrets) =>
  new Promise((resolve) => {
    const stop = secrets.subscribe(() => {
      if (secrets.status() === "ready") {
        stop();
        resolve();
      }
    });
  });

function setup(extra = {}) {
  const time = { ms: START };
  const session = { accountId: "preview-captain", activeChat: { id: "chat-alba", botId: "alba" } };
  const outcome = { value: "accepted" };
  const fixture = createSecretStandIn({ now: () => time.ms, bots: () => BOTS, accountId: "preview-captain", session: () => session, consumers: { "preview-status-only": async () => outcome.value }, ...extra });
  const bot = (botId) => fixture.botFor({ accountId: "preview-captain", botId });
  const api = fixture.captain;
  const ask = (botId, name, reason) => bot(botId).ask({ name, reason, consumerId: "preview-status-only" });
  const saveFor = (botId, name, key) => {
    session.activeChat = { id: "chat-" + botId, botId };
    return api.save({ kind: "direct", name, key }, VALUE);
  };
  const use = (botId, secretId) => bot(botId).use({ secretId, consumerId: "preview-status-only" });
  return { api, fixture, time, session, outcome, bot, ask, saveFor, use };
}

function once() {
  let armed = true;
  return () => {
    const was = armed;
    armed = false;
    return was;
  };
}

const request = (id) => ({ kind: "request", requestId: id, key: "save-" + id });
const direct = (name, key) => ({ kind: "direct", name, key });
const asRefused = (message) => (error) => {
  assert.equal(error.name, "Refused");
  if (message !== undefined) assert.equal(error.message, message);
  assert.equal(error.message.includes(VALUE), false);
  return true;
};

function assertNoCanaryFragments(serialized) {
  assert.equal(serialized.includes(CANARY), false);
  for (let start = 0; start < CANARY.length; start += 1) {
    for (let end = start + 1; end <= CANARY.length; end += 1) assert.equal(serialized.includes(CANARY.slice(start, end)), false, "canary fragment at " + start + " of length " + (end - start));
  }
}

test("the fragment check rejects every nonempty canary substring, including short prefixes and last four", () => {
  for (let start = 0; start < CANARY.length; start += 1) {
    for (let end = start + 1; end <= CANARY.length; end += 1) {
      const leaked = JSON.stringify({ observed: CANARY.slice(start, end) });
      assert.throws(() => assertNoCanaryFragments(leaked), { name: "AssertionError" }, "leaked fragment at " + start + " of length " + (end - start));
    }
  }
});

test("the stand-in's test value is shaped like a real token, so the paste rules would catch it", async () => {
  const { looksLikeSecret } = await load("src/domain/secrets.ts");
  assert.equal(looksLikeSecret(VALUE), true);
});

test("the Captain capability contains no bot operations or fixture controls", () => {
  const fixture = createSecretStandIn({ now: () => START, bots: () => BOTS, accountId: "preview-captain", session: () => ({ accountId: "preview-captain", activeChat: null }), consumers: {} });
  assert.deepEqual(Object.keys(fixture.captain).sort(), ["decline", "events", "remove", "replace", "requests", "rows", "save", "subscribe"]);
});

test("bot identity is copied from its fixture session and cannot be supplied in an operation", async () => {
  const { api, fixture, saveFor } = setup();
  const row = await saveFor("alba", "GITHUB_TOKEN", "identity-save");
  const session = { accountId: "preview-captain", botId: "iris" };
  const bot = fixture.botFor(session);
  session.botId = "alba";
  assert.throws(() => bot.ask({ botId: "alba", name: "DEPLOY_KEY", reason: "push", consumerId: "preview-status-only" }), asRefused());
  await assert.rejects(bot.use({ botId: "alba", secretId: row.id, consumerId: "preview-status-only" }), asRefused());
  await assert.rejects(bot.use({ secretId: row.id, consumerId: "preview-status-only" }), asRefused(secretText.useFailed("Iris", "that secret")));
  assert.equal(bot.ask({ name: "DEPLOY_KEY", reason: "push", consumerId: "preview-status-only" }).botId, "iris");
  assert.equal(api.rows("alba")[0].lastUsedAt, null);
  assert.throws(() => fixture.botFor({ accountId: "another-account", botId: "alba" }), asRefused());
});

test("direct save uses only the active chat and refuses caller-selected recipients and changed sessions", async () => {
  const { api, session, fixture } = setup();
  await assert.rejects(api.save({ ...direct("DEPLOY_KEY", "outside-chat"), botId: "iris" }, VALUE), asRefused());
  session.activeChat = null;
  await assert.rejects(api.save(direct("DEPLOY_KEY", "no-chat"), VALUE), asRefused());
  session.activeChat = { id: "chat-alba", botId: "alba" };
  const saving = api.save(direct("DEPLOY_KEY", "changed-chat"), VALUE);
  session.activeChat = { id: "chat-iris", botId: "iris" };
  await assert.rejects(saving, asRefused());
  session.accountId = "another-account";
  await assert.rejects(api.save(direct("DEPLOY_KEY", "wrong-account"), VALUE), asRefused());
  assert.throws(() => api.rows("alba"), asRefused());
  assert.deepEqual(fixture.snapshot(), { rows: [], requests: [], events: [] });
});

test("only a registered consumer outcome can record successful use", async () => {
  let calls = 0;
  let result = "accepted";
  const { api, bot, saveFor } = setup({ consumers: { "preview-status-only": async () => { calls += 1; if (result === "throw") throw new Error(VALUE); return result; } } });
  const row = await saveFor("alba", "GITHUB_TOKEN", "consumer-save");
  const owner = bot("alba");
  assert.throws(() => owner.ask({ name: "DEPLOY_KEY", reason: "push", consumerId: "unregistered" }), asRefused());
  await assert.rejects(owner.use({ secretId: row.id, consumerId: "unregistered" }), asRefused());
  await assert.rejects(owner.use({ secretId: row.id, consumerId: "preview-status-only", accepted: false }), asRefused());
  assert.equal(calls, 0);
  for (result of ["refused", "throw"]) {
    await assert.rejects(owner.use({ secretId: row.id, consumerId: "preview-status-only" }), asRefused());
    assert.equal(api.rows("alba")[0].lastUsedAt, null);
  }
  result = "accepted";
  await owner.use({ secretId: row.id, consumerId: "preview-status-only" });
  assert.equal(calls, 3);
  assert.equal(api.rows("alba")[0].lastUsedAt, stamp(START));
});

test("a save key cannot replay another bot or name and its original retry stays valid", async () => {
  const { api, fixture, saveFor } = setup();
  const row = await saveFor("alba", "GITHUB_TOKEN", "shared-save");
  const before = fixture.snapshot();
  await assert.rejects(saveFor("iris", "GITHUB_TOKEN", "shared-save"), asRefused());
  await assert.rejects(saveFor("alba", "DEPLOY_KEY", "shared-save"), asRefused());
  assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(await saveFor("alba", "GITHUB_TOKEN", "shared-save"), row);
  assert.equal(api.events("alba").length, 1);
});

test("replace keys are bound to the exact secret, bot and operation", async () => {
  const { api, time, fixture, saveFor } = setup();
  const first = await saveFor("alba", "GITHUB_TOKEN", "save-first");
  const second = await saveFor("alba", "DEPLOY_KEY", "save-second");
  const other = await saveFor("iris", "GITHUB_TOKEN", "save-other");
  time.ms += 1000;
  const replaced = await api.replace(first.id, VALUE, "shared-replace");
  const before = fixture.snapshot();
  await assert.rejects(api.replace(second.id, VALUE, "shared-replace"), asRefused());
  await assert.rejects(api.replace(other.id, VALUE, "shared-replace"), asRefused());
  await assert.rejects(api.replace(second.id, VALUE, "save-first"), asRefused());
  await assert.rejects(saveFor("alba", "ANOTHER_NAME", "shared-replace"), asRefused());
  assert.deepEqual(fixture.snapshot(), before);
  time.ms += 1000;
  assert.deepEqual(await api.replace(first.id, VALUE, "shared-replace"), replaced);
  assert.deepEqual(await saveFor("alba", "GITHUB_TOKEN", "save-first"), first);
  assert.deepEqual(fixture.snapshot(), before);
});

test("request keys cannot replay a different request or direct form", async () => {
  const { api, fixture, ask, saveFor } = setup();
  const first = ask("alba", "GITHUB_TOKEN", "push");
  const second = ask("iris", "DEPLOY_KEY", "deploy");
  const row = await api.save({ ...request(first.id), key: "request-key" }, VALUE);
  const before = fixture.snapshot();
  await assert.rejects(api.save({ ...request(second.id), key: "request-key" }, VALUE), asRefused());
  await assert.rejects(saveFor("alba", "GITHUB_TOKEN", "request-key"), asRefused());
  assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(await api.save({ ...request(first.id), key: "request-key" }, VALUE), row);
  assert.equal(api.requests("iris")[0].status, "asking");
});

test("deleted targets retain key bindings and retries cannot resurrect or redirect them", async () => {
  const { api, fixture, saveFor } = setup();
  const first = await saveFor("alba", "GITHUB_TOKEN", "deleted-key");
  await api.remove(first.id);
  const before = fixture.snapshot();
  await assert.rejects(saveFor("alba", "GITHUB_TOKEN", "deleted-key"), asRefused());
  await assert.rejects(saveFor("iris", "DEPLOY_KEY", "deleted-key"), asRefused());
  assert.deepEqual(fixture.snapshot(), before);
  assert.equal((await saveFor("iris", "DEPLOY_KEY", "fresh-key")).botId, "iris");
});

test("a bot asks, and asking again for the same name returns the same open request", () => {
  const { api, ask } = setup();
  const first = ask("alba", "GITHUB_TOKEN", "push the Search branch");
  assert.deepEqual(first, { id: first.id, botId: "alba", name: "GITHUB_TOKEN", reason: "push the Search branch", consumerId: "preview-status-only", at: stamp(START), status: "asking" });
  assert.deepEqual(ask("alba", "GITHUB_TOKEN", "push the Search branch"), first);
  assert.equal(api.requests("alba").length, 1);
  assert.deepEqual(api.requests("iris"), []);
});

test("a request from an unknown bot, with a bad name, or with a value in it is refused and kept out", () => {
  const { api, ask } = setup();
  assert.throws(() => ask("nobody", "GITHUB_TOKEN", "push"), asRefused("no such bot"));
  assert.throws(() => ask("alba", "", "push"), asRefused("Give the secret a name."));
  assert.throws(() => ask("alba", VALUE, "push"), asRefused(SECRET_TEXT.nameHint));
  assert.throws(() => ask("alba", "GITHUB_TOKEN", " "), asRefused());
  assert.throws(() => ask("alba", "GITHUB_TOKEN", "use " + VALUE), asRefused("A reason is plain words, not a secret value."));
  assert.deepEqual(api.requests("alba"), []);
});

test("saving a request makes one secret for that bot, and a retry does not make a second", async () => {
  const { api, time, ask } = setup();
  const asked = ask("alba", "GITHUB_TOKEN", "push the Search branch");
  time.ms += 60000;
  const row = await api.save(request(asked.id), VALUE);
  assert.deepEqual(row, { id: row.id, botId: "alba", name: "GITHUB_TOKEN", savedAt: stamp(START + 60000), lastUsedAt: null, locked: false });
  assert.deepEqual(api.rows("alba"), [row]);
  assert.deepEqual(api.rows("iris"), []);
  assert.equal(api.requests("alba")[0].status, "saved");
  const events = api.events("alba");
  assert.deepEqual(events, [{ id: events[0].id, botId: "alba", kind: "saved", name: "GITHUB_TOKEN", at: stamp(START + 60000) }]);
  time.ms += 60000;
  assert.deepEqual(await api.save(request(asked.id), VALUE), row);
  assert.equal(api.rows("alba").length, 1);
  assert.equal(api.events("alba").length, 1);
});

test("a request for a name that is already saved replaces that secret instead of adding another", async () => {
  const { api, time, ask, saveFor } = setup();
  const first = await saveFor("alba", "GITHUB_TOKEN", "k1");
  time.ms += 3600000;
  const asked = ask("alba", "GITHUB_TOKEN", "the old one expired");
  const second = await api.save(request(asked.id), VALUE);
  assert.equal(second.id, first.id);
  assert.equal(second.savedAt, stamp(START + 3600000));
  assert.equal(api.rows("alba").length, 1);
});

test("declining closes the request with no secret, a second decline changes nothing, and a closed request cannot be saved", async () => {
  const { api, ask } = setup();
  const asked = ask("alba", "GITHUB_TOKEN", "push");
  api.decline(asked.id);
  api.decline(asked.id);
  assert.equal(api.requests("alba")[0].status, "declined");
  assert.deepEqual(api.rows("alba"), []);
  assert.deepEqual(api.events("alba").map((item) => item.kind), ["declined"]);
  await assert.rejects(api.save(request(asked.id), VALUE), asRefused(secretText.ended("Alba")));
  assert.deepEqual(api.rows("alba"), []);
  assert.throws(() => api.decline("req-none"), asRefused("no such request"));
});

test("a secret the Captain opens himself saves once per key, and a second secret with the same name is refused", async () => {
  const { api, saveFor } = setup();
  const row = await saveFor("alba", "R2_ACCESS_KEY", "k1");
  assert.deepEqual(await saveFor("alba", "R2_ACCESS_KEY", "k1"), row);
  assert.equal(api.rows("alba").length, 1);
  assert.equal(api.events("alba").length, 1);
  await assert.rejects(saveFor("alba", "R2_ACCESS_KEY", "k2"), asRefused(secretText.taken("R2_ACCESS_KEY", "Alba")));
  assert.equal(api.rows("alba").length, 1);
  await saveFor("iris", "R2_ACCESS_KEY", "k3");
  assert.equal(api.rows("iris").length, 1);
});

test("a save with a value for a name, an empty value, a too long value or an unknown bot is refused, and no error repeats the value", async () => {
  const { api, saveFor } = setup();
  await assert.rejects(saveFor("alba", VALUE, "k1"), asRefused(SECRET_TEXT.nameHint));
  await assert.rejects(api.save(direct("R2_ACCESS_KEY", "k2"), ""), asRefused("Enter the secret."));
  await assert.rejects(api.save(direct("R2_ACCESS_KEY", "k3"), "z".repeat(9000)), asRefused());
  await assert.rejects(saveFor("nobody", "R2_ACCESS_KEY", "k4"), asRefused("Open the bot's active chat first."));
  await assert.rejects(api.save(request("req-none"), VALUE), asRefused("no such request"));
  assert.deepEqual(api.rows("alba"), []);
  assert.deepEqual(api.events("alba"), []);
});

test("a save that fails says so in the design's words, saves nothing, leaves the request open, and the retry works", async () => {
  const { api, ask } = setup({ failWrite: once() });
  const asked = ask("alba", "GITHUB_TOKEN", "push");
  await assert.rejects(api.save(request(asked.id), VALUE), (error) => {
    assert.equal(error.message, SECRET_TEXT.saveFailed);
    assert.equal(error.message.includes(VALUE), false);
    assert.equal(String(error.stack).includes(VALUE), false);
    return true;
  });
  assert.deepEqual(api.rows("alba"), []);
  assert.deepEqual(api.events("alba"), []);
  assert.equal(api.requests("alba")[0].status, "asking");
  const row = await api.save(request(asked.id), VALUE);
  assert.deepEqual(api.rows("alba"), [row]);
});

test("replacing gives the secret a new saved time and a fresh last used, and a retry with the same key does not apply twice", async () => {
  const { api, time, saveFor, use } = setup();
  const first = await saveFor("alba", "GITHUB_TOKEN", "k1");
  time.ms += 3600000;
  await use("alba", first.id);
  assert.equal(api.rows("alba")[0].lastUsedAt, stamp(START + 3600000));
  time.ms += 3600000;
  const replaced = await api.replace(first.id, VALUE, "r1");
  assert.equal(replaced.id, first.id);
  assert.equal(replaced.savedAt, stamp(START + 7200000));
  assert.equal(replaced.lastUsedAt, null);
  time.ms += 3600000;
  assert.deepEqual(await api.replace(first.id, VALUE, "r1"), replaced);
  assert.equal(api.rows("alba").length, 1);
  assert.equal(api.events("alba").length, 2);
});

test("a replace that fails leaves the old secret exactly as it was and says the old one is still saved", async () => {
  let writes = 0;
  const { api, time, saveFor } = setup({ failWrite: () => ++writes === 2 });
  const saved = await saveFor("alba", "GITHUB_TOKEN", "k1");
  time.ms += 3600000;
  await assert.rejects(api.replace(saved.id, VALUE, "r1"), (error) => {
    assert.equal(error.message, SECRET_TEXT.replaceFailed);
    assert.equal(error.message.includes(VALUE), false);
    return true;
  });
  assert.deepEqual(api.rows("alba"), [saved]);
  assert.equal(api.events("alba").length, 1);
  const retried = await api.replace(saved.id, VALUE, "r1");
  assert.equal(retried.savedAt, stamp(START + 3600000));
});

test("replacing a secret that is gone or locked is refused", async () => {
  const { api, fixture, saveFor } = setup();
  await assert.rejects(api.replace("sec-none", VALUE, "r1"), asRefused("no such secret"));
  const row = await saveFor("alba", "GITHUB_TOKEN", "k1");
  fixture.removeBot("alba");
  await assert.rejects(api.replace(row.id, VALUE, "r2"), asRefused(secretText.lockedWhy("Alba")));
  await assert.rejects(api.replace(row.id, "", "r3"), asRefused("Enter the secret."));
});

test("deleting takes the secret away at once, deleting twice is fine, and the bot cannot use it afterwards", async () => {
  const { api, saveFor, use } = setup();
  const row = await saveFor("alba", "GITHUB_TOKEN", "k1");
  await api.remove(row.id);
  await api.remove(row.id);
  assert.deepEqual(api.rows("alba"), []);
  await assert.rejects(use("alba", row.id), asRefused(secretText.useFailed("Alba", "that secret")));
  await assert.rejects(saveFor("alba", "GITHUB_TOKEN", "k1"), asRefused());
});

test("a use by the bot that owns the secret sets last used, a refused or failed use does not, and another bot cannot use it", async () => {
  const { api, time, outcome, saveFor, use } = setup();
  const row = await saveFor("alba", "GITHUB_TOKEN", "k1");
  time.ms += 120000;
  outcome.value = "refused";
  await assert.rejects(use("alba", row.id), asRefused());
  assert.equal(api.rows("alba")[0].lastUsedAt, null);
  outcome.value = "accepted";
  await use("alba", row.id);
  assert.equal(api.rows("alba")[0].lastUsedAt, stamp(START + 120000));
  time.ms += 120000;
  await assert.rejects(use("iris", row.id), (error) => {
    assert.equal(error.name, "Refused");
    assert.equal(error.message, secretText.useFailed("Iris", "that secret"));
    assert.equal(error.message.includes("GITHUB_TOKEN"), false);
    return true;
  });
  assert.equal(api.rows("alba")[0].lastUsedAt, stamp(START + 120000));
  await assert.rejects(use("alba", "sec-none"), asRefused());
});

test("when a bot is removed its secrets stay as locked rows, its open requests end, and nothing about it works again", async () => {
  const { api, fixture, ask, saveFor, use } = setup();
  const row = await saveFor("alba", "GITHUB_TOKEN", "k1");
  const open = ask("alba", "DEPLOY_KEY", "push");
  const other = ask("iris", "DEPLOY_KEY", "push");
  fixture.removeBot("alba");
  assert.deepEqual(api.rows("alba"), [{ ...row, locked: true }]);
  assert.equal(api.requests("alba").find((item) => item.id === open.id).status, "ended");
  assert.deepEqual(api.events("alba").map((item) => item.kind), ["saved", "ended"]);
  assert.equal(api.requests("iris").find((item) => item.id === other.id).status, "asking");
  await assert.rejects(api.save(request(open.id), VALUE), asRefused(secretText.ended("Alba")));
  assert.throws(() => ask("alba", "DEPLOY_KEY", "push"), asRefused("no such bot"));
  await assert.rejects(use("alba", row.id), asRefused(secretText.useFailed("Alba", "GITHUB_TOKEN")));
  await api.remove(row.id);
  assert.deepEqual(api.rows("alba"), []);
});

async function observeSecretSurfaces(work) {
  const seen = [];
  const calls = [];
  const spied = {};
  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    spied[level] = console[level];
    console[level] = (...args) => calls.push(level + ":" + args.map(String).join(" "));
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push("fetch:" + args.map(String).join(" "));
    return Promise.reject(new Error("no network"));
  };
  const storages = {};
  for (const name of ["localStorage", "sessionStorage"]) {
    storages[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: { setItem: (...args) => calls.push(name + ":" + args.join(" ")), getItem: () => null, removeItem: () => undefined }, configurable: true, writable: true });
  }
  try {
    await work(seen);
  } finally {
    for (const level of Object.keys(spied)) console[level] = spied[level];
    globalThis.fetch = realFetch;
    for (const [name, descriptor] of Object.entries(storages)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  const everything = JSON.stringify(seen) + calls.join("\n");
  assert.equal(everything.includes(VALUE), false);
  assertNoCanaryFragments(everything);
  assert.deepEqual(calls, []);
  return everything;
}

const byNextTurn = (work) => Promise.race([
  work.then((value) => ({ state: "accepted", value }), (error) => ({ state: "refused", name: error.name, message: error.message, stack: String(error.stack) })),
  new Promise((resolve) => setImmediate(() => resolve({ state: "pending" }))),
]);

for (const operation of ["save", "replace"]) test("an unready " + operation + " is refused before loading resolves and observed surfaces contain no canary fragments", async () => {
  await observeSecretSurfaces(async (seen) => {
    const { api, fixture, time } = setup();
    const row = operation === "replace" ? await api.save(direct("DEPLOY_KEY", "seed-replace"), CANARY) : null;
    time.ms += 1000;
    let release;
    const part = new Promise((resolve) => { release = () => resolve(api); });
    const lazy = lazySecrets(() => part);
    const ready = arrived(lazy);
    const before = fixture.snapshot();
    const outcome = await byNextTurn(operation === "save" ? lazy.save(direct("DEPLOY_KEY", "cold-save"), CANARY) : lazy.replace(row.id, CANARY, "cold-replace"));
    seen.push(outcome, { status: lazy.status(), snapshot: fixture.snapshot() });
    assert.deepEqual([outcome.state, outcome.name, outcome.message], ["refused", "Refused", "Secret controls are not ready yet."]);
    assert.deepEqual(fixture.snapshot(), before);
    release();
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    seen.push({ status: lazy.status(), snapshot: fixture.snapshot() });
    assert.deepEqual(fixture.snapshot(), before);
  });
});

for (const throughLazy of [false, true]) test("serialized " + (throughLazy ? "ready lazy wrapper" : "stand-in") + " results, snapshots, errors and intercepted console, storage and fetch calls contain no canary fragments", async () => {
  const everything = await observeSecretSurfaces(async (seen) => {
    const { api: captain, time, fixture, ask, use } = setup({ failWrite: (() => { let n = 0; return () => ++n === 3; })() });
    const api = throughLazy ? lazySecrets(() => Promise.resolve(captain)) : captain;
    if (throughLazy) await arrived(api);
    const asked = ask("alba", "GITHUB_TOKEN", "push the Search branch");
    seen.push(asked);
    seen.push(await api.save(request(asked.id), CANARY));
    time.ms += 1000;
    for (const work of [
      () => api.save(direct(VALUE, "k1"), CANARY),
      () => api.save(direct("R2_ACCESS_KEY", "k2"), CANARY),
      () => api.replace(api.rows("alba")[0].id, CANARY, "r1"),
      () => api.save(direct("R2_ACCESS_KEY", "k3"), CANARY),
      () => api.save(direct("R2_ACCESS_KEY", "k4"), ""),
      () => api.replace("sec-none", CANARY, "r2"),
      () => use("iris", api.rows("alba")[0].id),
    ]) {
      try {
        seen.push(await work());
      } catch (error) {
        seen.push({ name: error.name, message: error.message, stack: String(error.stack) });
      }
    }
    fixture.removeBot("alba");
    seen.push(fixture.snapshot());
    for (const [name, member] of Object.entries(api)) assert.equal(typeof member, "function", name);
    const snapshot = fixture.snapshot();
    for (const row of snapshot.rows) assert.deepEqual(Object.keys(row).sort(), ["botId", "id", "lastUsedAt", "locked", "name", "savedAt"]);
    for (const item of snapshot.requests) assert.deepEqual(Object.keys(item).sort(), ["at", "botId", "consumerId", "id", "name", "reason", "status"]);
    for (const item of snapshot.events) assert.deepEqual(Object.keys(item).sort(), ["at", "botId", "id", "kind", "name"]);
  });
  assert.equal(everything.includes("GITHUB_TOKEN") && everything.includes("Could not save the secret"), true);
});

test("the stand-in tells a listener about every change and nothing after it stops listening", async () => {
  const { api, fixture, ask, use } = setup();
  let heard = 0;
  const stop = api.subscribe(() => {
    heard += 1;
  });
  const asked = ask("alba", "GITHUB_TOKEN", "push");
  const row = await api.save(request(asked.id), VALUE);
  await use("alba", row.id);
  await api.replace(row.id, VALUE, "r1");
  await api.remove(row.id);
  ask("alba", "DEPLOY_KEY", "push");
  assert.equal(heard, 6);
  stop();
  fixture.removeBot("alba");
  assert.equal(heard, 6);
});

test("the example data's secrets start unloaded: saying loading, with empty lists", () => {
  const { secrets } = createExampleData({ delay: 0, fail: new Set(), fixtures: "off", empty: false });
  assert.equal(secrets.status(), "loading");
  assert.deepEqual([secrets.rows("alba"), secrets.requests("alba"), secrets.events("alba")], [[], [], []]);
});

test("the example data carries a few secrets for the screens: saved, never used, locked, asking and declined", async () => {
  const { secrets } = createExampleData({ delay: 0, fail: new Set(), fixtures: "off", empty: false });
  await arrived(secrets);
  assert.deepEqual(secrets.rows("alba").map((row) => [row.name, row.lastUsedAt === null, row.locked]), [
    ["GITHUB_TOKEN", false, false],
    ["R2_ACCESS_KEY", true, false],
  ]);
  assert.deepEqual(secrets.rows("pib").map((row) => [row.name, row.locked]), [["STAGING_DEPLOY_KEY", true]]);
  assert.deepEqual(secrets.requests("alba").map((item) => [item.name, item.status]), [["DEPLOY_KEY", "asking"]]);
  assert.deepEqual(secrets.requests("dr-kivo").map((item) => [item.name, item.status]), [["NPM_TOKEN", "declined"]]);
  assert.deepEqual(secrets.rows("iris"), []);
  assert.equal("ask" in secrets || "use" in secrets || "botFor" in secrets || "snapshot" in secrets, false);
  const row = await secrets.save(request("req-a1"), VALUE);
  assert.equal(row.name, "DEPLOY_KEY");
});

test("with ?fail=secret the first save in the example data fails in the design's words and the next one works", async () => {
  const { secrets } = createExampleData({ delay: 0, fail: new Set(["secret"]), fixtures: "off", empty: false });
  await arrived(secrets);
  await assert.rejects(secrets.save(request("req-a1"), VALUE), { message: SECRET_TEXT.saveFailed });
  assert.equal(secrets.requests("alba")[0].status, "asking");
  assert.equal((await secrets.save(request("req-a1"), VALUE)).name, "DEPLOY_KEY");
});

test("the trusted request boundary rejects injected metadata and bot display names without storing it", () => {
  for (const text of ["push\nSecret saved: X", "push\u202enow", "Only you can access it.", "Zero knowledge.", "Secret saved: X", "Save securely"]) {
    const { fixture, ask } = setup();
    assert.throws(() => ask("alba", text, "push"), asRefused());
    assert.throws(() => ask("alba", "DEPLOY_KEY", text), asRefused());
    assert.deepEqual(fixture.snapshot(), { rows: [], requests: [], events: [] });
    const { fixture: poisoned, ask: poisonedAsk } = setup({ bots: () => [{ id: "alba", name: text }] });
    assert.throws(() => poisonedAsk("alba", "DEPLOY_KEY", "push"), asRefused());
    assert.deepEqual(poisoned.snapshot(), { rows: [], requests: [], events: [] });
  }
});

test("session-bound requests refuse paraphrased promises and statuses without storing or echoing them", () => {
  for (const text of ["Quarterdeck will not decrypt it.", "Only the Captain can access it.", "The secret has been saved."]) {
    const { fixture, ask } = setup();
    for (const [name, reason, message] of [
      [text, "push", "A name cannot be an app status, action or privacy promise."],
      ["DEPLOY_KEY", text, "A reason cannot be an app status, action or privacy promise."],
    ]) {
      assert.throws(() => ask("alba", name, reason), (error) => {
        assert.equal(error.name, "Refused");
        assert.equal(error.message, message);
        assert.equal(error.message.includes(text), false);
        return true;
      });
    }
    assert.deepEqual(fixture.snapshot(), { rows: [], requests: [], events: [] });
    const poisoned = setup({ bots: () => [{ id: "alba", name: text }] });
    assert.throws(() => poisoned.ask("alba", "DEPLOY_KEY", "push"), (error) => {
      assert.equal(error.name, "Refused");
      assert.equal(error.message, "A bot label must be plain text without a status or privacy promise.");
      assert.equal(error.message.includes(text), false);
      return true;
    });
    assert.deepEqual(poisoned.fixture.snapshot(), { rows: [], requests: [], events: [] });
  }
});

test("session-bound requests keep the three ordinary free-text reasons", () => {
  const { api, ask } = setup();
  const reasons = ["Needed to deploy the billing service", "API key for GitHub access", "Used to read the build logs"];
  for (const [at, reason] of reasons.entries()) assert.equal(ask("alba", "REQUEST_" + at, reason).reason, reason);
  assert.deepEqual(api.requests("alba").map((request) => request.reason), reasons);
});
