import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { lazyChat, lazySecrets } = await load("src/data/lazy-parts.ts");
const { createSecretStandIn } = await load("src/data/secret-standin.ts");

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const VALUE = "ghp_" + Array.from({ length: 36 }, (_, i) => CHARS[(i * 17 + ((i * i) % 11) + 3) % CHARS.length]).join("");

function gate() {
  const held = { loads: 0, open: null, fail: null };
  const arrive = (part) =>
    new Promise((resolve, reject) => {
      held.loads += 1;
      held.open = () => resolve(part);
      held.fail = () => reject(new Error("the part did not load"));
    });
  return { held, arrive };
}

function parkedSecrets(decorate = (api) => api) {
  const session = { accountId: "preview-captain", activeChat: { id: "chat-alba", botId: "alba" } };
  const stand = createSecretStandIn({
    now: () => Date.parse("2026-11-02T10:00:00-05:00"),
    bots: () => [{ id: "alba", name: "Alba" }, { id: "iris", name: "Iris" }],
    accountId: "preview-captain",
    session: () => session,
    consumers: { "preview-status-only": async () => "accepted" },
  });
  const asked = stand.botFor({ accountId: "preview-captain", botId: "alba" }).ask({ name: "GITHUB_TOKEN", reason: "push", consumerId: "preview-status-only" });
  const target = { kind: "request", requestId: asked.id, key: "save-" + asked.id };
  const { held, arrive } = gate();
  const lazy = lazySecrets(() => arrive(decorate(stand.captain)));
  return { stand, target, held, lazy, session };
}

const reaches = (secrets, state) =>
  new Promise((resolve) => {
    const stop = secrets.subscribe(() => {
      if (secrets.status() === state) {
        stop();
        resolve();
      }
    });
  });

const byNextTurn = (work) => Promise.race([
  work.then(() => ({ state: "accepted" }), (error) => ({ state: "refused", name: error.name, message: error.message })),
  new Promise((resolve) => setImmediate(() => resolve({ state: "pending" }))),
]);

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("the secret wrapper starts nothing until something listens, and says loading", () => {
  const { held, lazy } = parkedSecrets();
  assert.equal(held.loads, 0);
  assert.equal(lazy.status(), "loading");
});

test("before the secret part arrives its lists are empty although the stand-in holds a request", () => {
  const { stand, lazy } = parkedSecrets();
  assert.equal(stand.captain.requests("alba").length, 1);
  assert.deepEqual([lazy.rows("alba"), lazy.requests("alba"), lazy.events("alba")], [[], [], []]);
});

test("a listener starts the secret part loading, and when it arrives the listener hears it once and the lists show the stand-in's", async () => {
  const { stand, held, lazy } = parkedSecrets();
  let heard = 0;
  lazy.subscribe(() => {
    heard += 1;
  });
  assert.equal(held.loads, 1);
  const arrived = reaches(lazy, "ready");
  held.open();
  await arrived;
  assert.equal(heard, 1);
  assert.equal(lazy.status(), "ready");
  assert.deepEqual(lazy.requests("alba"), stand.captain.requests("alba"));
});

test("a listener that stopped before the secret part arrived hears nothing", async () => {
  const { held, lazy } = parkedSecrets();
  let heard = 0;
  const stop = lazy.subscribe(() => {
    heard += 1;
  });
  stop();
  const arrived = reaches(lazy, "ready");
  held.open();
  await arrived;
  assert.equal(heard, 0);
});

test("a failed secret load says failed to its listeners, and reload asks again and then works", async () => {
  const { held, lazy } = parkedSecrets();
  const heard = [];
  lazy.subscribe(() => {
    heard.push(lazy.status());
  });
  const failed = reaches(lazy, "failed");
  held.fail();
  await failed;
  lazy.reload();
  assert.equal(held.loads, 2);
  assert.equal(lazy.status(), "loading");
  const again = reaches(lazy, "ready");
  held.open();
  await again;
  assert.deepEqual(heard, ["failed", "loading", "ready"]);
  assert.equal(held.loads, 2);
});

test("reload does nothing while the secret part is loading or ready", async () => {
  const { held, lazy } = parkedSecrets();
  const arrived = reaches(lazy, "ready");
  lazy.reload();
  held.open();
  await arrived;
  lazy.reload();
  assert.equal(held.loads, 1);
});

test("a save after the secret part is ready delegates to the stand-in unchanged", async () => {
  const { stand, held, target, lazy } = parkedSecrets();
  const ready = reaches(lazy, "ready");
  held.open();
  await ready;
  const row = await lazy.save(target, VALUE);
  assert.equal(row.name, "GITHUB_TOKEN");
  assert.deepEqual(stand.captain.rows("alba").map((item) => item.id), [row.id]);
});

test("a save after a failed secret load is refused without starting another load", async () => {
  const { stand, held, target, lazy } = parkedSecrets();
  const failed = reaches(lazy, "failed");
  held.fail();
  await failed;
  assert.deepEqual(await byNextTurn(lazy.save(target, VALUE)), { state: "refused", name: "Refused", message: "Secret controls are not ready yet." });
  assert.equal(held.loads, 1);
  assert.deepEqual(stand.captain.rows("alba"), []);
  assert.equal(lazy.status(), "failed");
});

test("an unready direct save cannot move from chat A to chat B when loading finishes", async () => {
  const { stand, held, lazy, session } = parkedSecrets();
  const ready = reaches(lazy, "ready");
  const saving = lazy.save({ kind: "direct", name: "DEPLOY_KEY", key: "cold-direct" }, VALUE).then(
    (row) => ({ row }),
    (error) => ({ name: error.name, message: error.message }),
  );
  session.activeChat = { id: "chat-iris", botId: "iris" };
  held.open();
  await ready;
  assert.deepEqual(await saving, { name: "Refused", message: "Secret controls are not ready yet." });
  assert.deepEqual(stand.captain.rows("alba"), []);
  assert.deepEqual(stand.captain.rows("iris"), []);
  assert.deepEqual(stand.snapshot().events, []);
});

test("a ready direct save captures chat A before an immediate switch to chat B", async () => {
  const { stand, held, lazy, session } = parkedSecrets();
  const ready = reaches(lazy, "ready");
  held.open();
  await ready;
  const saving = lazy.save({ kind: "direct", name: "DEPLOY_KEY", key: "ready-direct" }, VALUE);
  session.activeChat = { id: "chat-iris", botId: "iris" };
  await assert.rejects(saving, { name: "Refused", message: "The active chat changed. Open a new secret box." });
  assert.deepEqual(stand.captain.rows("alba"), []);
  assert.deepEqual(stand.captain.rows("iris"), []);
  assert.deepEqual(stand.snapshot().events, []);
});

test("an unready remove is refused without queuing a deletion after loading", async () => {
  const { stand, held, target, lazy } = parkedSecrets();
  const row = await stand.captain.save(target, VALUE);
  const before = stand.snapshot();
  const ready = reaches(lazy, "ready");
  assert.deepEqual(await byNextTurn(lazy.remove(row.id)), { state: "refused", name: "Refused", message: "Secret controls are not ready yet." });
  held.open();
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stand.snapshot(), before);
  await lazy.remove(row.id);
  assert.deepEqual(lazy.rows("alba"), []);
});

for (const operation of ["save", "replace", "remove"]) test("an unready " + operation + " refuses without starting the loader", async () => {
  const { held, target, lazy } = parkedSecrets();
  const work = operation === "save" ? lazy.save(target, VALUE) : operation === "replace" ? lazy.replace("sec-none", VALUE, "cold-replace") : lazy.remove("sec-none");
  assert.deepEqual(await byNextTurn(work), { state: "refused", name: "Refused", message: "Secret controls are not ready yet." });
  assert.equal(held.loads, 0);
  assert.equal(lazy.status(), "loading");
});

test("a ready direct save keeps chat A when the session stays unchanged", async () => {
  const { held, lazy } = parkedSecrets();
  const ready = reaches(lazy, "ready");
  held.open();
  await ready;
  const row = await lazy.save({ kind: "direct", name: "DEPLOY_KEY", key: "same-chat" }, VALUE);
  assert.equal(row.botId, "alba");
  assert.deepEqual(lazy.rows("alba"), [row]);
  assert.deepEqual(lazy.rows("iris"), []);
});

test("declining before the secret part arrives changes nothing", () => {
  const { stand, target, lazy } = parkedSecrets();
  lazy.decline(target.requestId);
  assert.equal(stand.captain.requests("alba")[0].status, "asking");
});

test("a ready subscriber from another account is refused and hears no later change", async () => {
  const { held, lazy, session, target } = parkedSecrets();
  const ready = reaches(lazy, "ready");
  held.open();
  await ready;
  let heard = 0;
  session.accountId = "another-account";
  assert.throws(() => lazy.subscribe(() => { heard += 1; }), { name: "Refused" });
  session.accountId = "preview-captain";
  await lazy.save(target, VALUE);
  assert.equal(heard, 0);
});

test("an authorized ready subscriber hears changes until its cleanup", async () => {
  const { held, lazy, target } = parkedSecrets();
  const ready = reaches(lazy, "ready");
  held.open();
  await ready;
  let heard = 0;
  const stop = lazy.subscribe(() => { heard += 1; });
  const row = await lazy.save(target, VALUE);
  assert.equal(heard, 1);
  stop();
  await lazy.remove(row.id);
  assert.equal(heard, 1);
});

test("a cold subscriber is individually refused at arrival under another account", async () => {
  const attempted = [];
  const { held, lazy, session, target } = parkedSecrets((api) => ({
    ...api,
    subscribe: (listener) => { attempted.push(listener); return api.subscribe(listener); },
  }));
  let heard = 0;
  const listener = () => { heard += 1; };
  const stop = lazy.subscribe(listener);
  session.accountId = "another-account";
  held.open();
  await nextTurn();
  assert.equal(attempted.includes(listener), true);
  assert.equal(lazy.status(), "ready");
  session.accountId = "preview-captain";
  await lazy.save(target, VALUE);
  assert.equal(heard, 0);
  stop();
});

test("one refused cold subscriber leaves another subscriber and ready controls working", async () => {
  let refusedHeard = 0;
  let allowedHeard = 0;
  const refused = () => { refusedHeard += 1; };
  const { held, lazy, target } = parkedSecrets((api) => ({
    ...api,
    subscribe: (listener) => {
      if (listener === refused) throw new Error("one subscriber refused");
      return api.subscribe(listener);
    },
  }));
  lazy.subscribe(refused);
  const stop = lazy.subscribe(() => { allowedHeard += 1; });
  held.open();
  await nextTurn();
  assert.equal(lazy.status(), "ready");
  assert.deepEqual([refusedHeard, allowedHeard], [0, 1]);
  const row = await lazy.save(target, VALUE);
  assert.deepEqual([refusedHeard, allowedHeard], [0, 2]);
  stop();
  await lazy.remove(row.id);
  assert.deepEqual([refusedHeard, allowedHeard], [0, 2]);
});

test("a cold subscriber stopped before arrival never reaches the stand-in", async () => {
  let registered = 0;
  const { held, lazy } = parkedSecrets((api) => ({
    ...api,
    subscribe: (listener) => { registered += 1; return api.subscribe(listener); },
  }));
  const stop = lazy.subscribe(() => assert.fail("stopped subscriber called"));
  stop();
  held.open();
  await nextTurn();
  assert.equal(lazy.status(), "ready");
  assert.equal(registered, 0);
});

test("a ready subscription returns the stand-in cleanup unchanged", async () => {
  let underlyingStop;
  const { held, lazy } = parkedSecrets((api) => ({
    ...api,
    subscribe: (listener) => { underlyingStop = api.subscribe(listener); return underlyingStop; },
  }));
  const ready = reaches(lazy, "ready");
  held.open();
  await ready;
  const stop = lazy.subscribe(() => undefined);
  assert.equal(stop, underlyingStop);
  stop();
});

test("stopping during cold registration releases the eventual cleanup once", async () => {
  let stop;
  let cleaned = 0;
  const { held, lazy, target } = parkedSecrets((api) => ({
    ...api,
    subscribe: (listener) => {
      const underlyingStop = api.subscribe(listener);
      stop();
      return () => { cleaned += 1; underlyingStop(); };
    },
  }));
  stop = lazy.subscribe(() => assert.fail("stopped subscriber called"));
  held.open();
  await nextTurn();
  assert.equal(cleaned, 1);
  stop();
  assert.equal(cleaned, 1);
  await lazy.save(target, VALUE);
});

test("a shared arrival failure leaves failed and reload restores all ready controls", async () => {
  let attempts = 0;
  const { held, lazy, target } = parkedSecrets((api) => {
    if (++attempts === 1) throw new Error("part setup failed");
    return api;
  });
  const states = [];
  lazy.subscribe(() => states.push(lazy.status()));
  await nextTurn();
  assert.equal(lazy.status(), "failed");
  assert.deepEqual(lazy.rows("alba"), []);
  assert.deepEqual(await byNextTurn(lazy.save(target, VALUE)), { state: "refused", name: "Refused", message: "Secret controls are not ready yet." });
  lazy.reload();
  assert.equal(attempts, 2);
  assert.equal(lazy.status(), "loading");
  held.open();
  await nextTurn();
  assert.equal(lazy.status(), "ready");
  const row = await lazy.save(target, VALUE);
  assert.equal((await lazy.replace(row.id, VALUE, "recovered-replace")).id, row.id);
  await lazy.remove(row.id);
  assert.deepEqual(lazy.rows("alba"), []);
  assert.deepEqual(states.slice(0, 3), ["failed", "loading", "ready"]);
});

test("the lazy secret object exposes exactly Captain operations plus status and reload", () => {
  const { lazy } = parkedSecrets();
  assert.deepEqual(Object.keys(lazy).sort(), ["decline", "events", "reload", "remove", "replace", "requests", "rows", "save", "status", "subscribe"]);
});

function fakeChat() {
  const log = { watched: 0, subscribed: 0, stopped: 0 };
  const rows = [{ bot: { id: "iris" }, preview: "hi", at: "2026-11-02T10:00:00-05:00", unread: false }];
  const api = {
    uploadBoundary: "browser-stand-in",
    listChats: async () => rows,
    openThread: async (botId) => ({ bot: { id: botId }, messages: [], seenUpTo: null, seenAt: null, working: null, firstUnread: null, features: [] }),
    send: async (botId, message) => ({ id: "m1", from: "captain", text: message.text, at: "2026-11-02T10:00:00-05:00", refs: [], uploadVerdicts: [], botId }),
    watchChats: () => {
      log.watched += 1;
      return () => {
        log.stopped += 1;
      };
    },
    subscribe: () => {
      log.subscribed += 1;
      return () => {
        log.stopped += 1;
      };
    },
  };
  return { api, rows, log };
}

test("the chat wrapper loads nothing until a chat call is made", () => {
  const { held, arrive } = gate();
  lazyChat(() => arrive(fakeChat().api));
  assert.equal(held.loads, 0);
});

test("a chat call waits for the chat part and passes its answer through", async () => {
  const { api, rows } = fakeChat();
  const { held, arrive } = gate();
  const chat = lazyChat(() => arrive(api));
  const listing = chat.listChats();
  held.open();
  assert.deepEqual(await listing, rows);
});

test("a send waits for the chat part and reaches it with the same message", async () => {
  const { api } = fakeChat();
  const { held, arrive } = gate();
  const chat = lazyChat(() => arrive(api));
  const sending = chat.send("iris", { text: "hello", clientId: "c1" });
  held.open();
  assert.equal((await sending).text, "hello");
});

test("the lazy example chat preserves its browser-only upload verdict", async () => {
  const { api } = fakeChat();
  const response = await api.send("iris", { text: "file", clientId: "verdict" });
  response.uploadVerdicts.push({ filename: "notes.txt", detectedType: "text/plain", checkedBy: "browser-stand-in", serverRecheckRequired: true });
  api.send = async () => response;
  const chat = lazyChat(async () => api);
  assert.equal(chat.uploadBoundary, "browser-stand-in");
  assert.equal(await chat.send("iris", { text: "file", clientId: "verdict" }), response);
});

test("watching before the chat part arrives starts watching when it arrives", async () => {
  const { api, log } = fakeChat();
  const { held, arrive } = gate();
  const part = arrive(api);
  const chat = lazyChat(() => part);
  chat.watchChats(() => undefined);
  chat.subscribe("iris", () => undefined);
  assert.deepEqual([log.watched, log.subscribed], [0, 0]);
  held.open();
  await chat.listChats();
  assert.deepEqual([log.watched, log.subscribed], [1, 1]);
});

test("stopping a watch before the chat part arrives means it never starts", async () => {
  const { api, log } = fakeChat();
  const { held, arrive } = gate();
  const part = arrive(api);
  const chat = lazyChat(() => part);
  chat.watchChats(() => undefined)();
  chat.subscribe("iris", () => undefined)();
  held.open();
  await chat.listChats();
  assert.deepEqual([log.watched, log.subscribed, log.stopped], [0, 0, 0]);
});

test("stopping a watch after it started stops the chat part's own watch", async () => {
  const { api, log } = fakeChat();
  const { held, arrive } = gate();
  const part = arrive(api);
  const chat = lazyChat(() => part);
  const stop = chat.watchChats(() => undefined);
  held.open();
  await chat.listChats();
  stop();
  assert.equal(log.stopped, 1);
});

test("a chat call after a failed chat load asks the loader again and works", async () => {
  const { api, rows } = fakeChat();
  let asked = 0;
  const chat = lazyChat(() => {
    asked += 1;
    return asked === 1 ? Promise.reject(new Error("the part did not load")) : Promise.resolve(api);
  });
  await assert.rejects(chat.listChats(), { message: "the part did not load" });
  assert.deepEqual(await chat.listChats(), rows);
  assert.equal(asked, 2);
});

test("a watch started during a failed chat load starts when a later chat call loads the part", async () => {
  const { api, log } = fakeChat();
  const { held, arrive } = gate();
  let part = arrive(api);
  const chat = lazyChat(() => part);
  chat.watchChats(() => undefined);
  chat.subscribe("iris", () => undefined);
  held.fail();
  await nextTurn();
  assert.deepEqual([log.watched, log.subscribed], [0, 0]);
  part = Promise.resolve(api);
  await chat.listChats();
  assert.deepEqual([log.watched, log.subscribed], [1, 1]);
  await chat.listChats();
  assert.deepEqual([log.watched, log.subscribed], [1, 1]);
});

test("a watch stopped while it was owed the part never starts, and one that did start stops cleanly", async () => {
  const { api, log } = fakeChat();
  const { held, arrive } = gate();
  let part = arrive(api);
  const chat = lazyChat(() => part);
  chat.watchChats(() => undefined)();
  const stopKept = chat.subscribe("iris", () => undefined);
  held.fail();
  await nextTurn();
  part = Promise.resolve(api);
  await chat.listChats();
  assert.deepEqual([log.watched, log.subscribed, log.stopped], [0, 1, 0]);
  stopKept();
  stopKept();
  assert.equal(log.stopped, 1);
});

test("a watch that throws as it starts is dropped and leaves the chat calls and the other watches working", async () => {
  const { api, rows, log } = fakeChat();
  const watchChats = api.watchChats;
  api.watchChats = () => {
    throw new Error("the watch refused to start");
  };
  const chat = lazyChat(async () => api);
  chat.watchChats(() => undefined);
  chat.subscribe("iris", () => undefined);
  assert.deepEqual(await chat.listChats(), rows);
  assert.deepEqual([log.watched, log.subscribed], [0, 1]);
  api.watchChats = watchChats;
  await chat.listChats();
  assert.equal(log.watched, 0);
});
