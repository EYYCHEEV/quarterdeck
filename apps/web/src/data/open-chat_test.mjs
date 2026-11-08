import assert from "node:assert/strict";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createExampleParts } = await load("src/data/example-parts.ts");
const { lazyChat, lazySecrets } = await load("src/data/lazy-parts.ts");

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const VALUE = "ghp_" + Array.from({ length: 36 }, (_, i) => CHARS[(i * 17 + ((i * i) % 11) + 3) % CHARS.length]).join("");
const NOT_OPEN = { name: "Refused", message: "Open the bot's active chat first." };
const CHANGED = { name: "Refused", message: "The active chat changed. Open a new secret box." };
const NAME = "OPEN_CHAT_PROBE";
const BOTS = ["alba", "iris", "dr-kivo", "shelvorn", "dale"];

function exampleParts() {
  const switches = { delay: 0, fail: new Set(), fixtures: "off", empty: false, chat: null, mail: null };
  return createExampleParts(switches, () => Date.parse("2026-11-02T10:00:00-05:00"), () => () => false);
}

const openChat = (chat, botId) => chat.subscribe(botId, () => undefined);
const saveDirect = (secrets, key, extra = {}) => secrets.save({ kind: "direct", name: NAME, key, ...extra }, VALUE);
const holders = (secrets) => BOTS.flatMap((botId) => secrets.rows(botId).filter((row) => row.name === NAME).map((row) => row.botId));

test("with no chat open a direct save is refused and nothing is saved", async () => {
  const { secrets } = exampleParts();
  await assert.rejects(saveDirect(secrets, "none-open"), NOT_OPEN);
  assert.deepEqual(holders(secrets), []);
});

test("with a chat open a direct save lands in that chat's bot and in no other", async () => {
  const { chat, secrets } = exampleParts();
  openChat(chat, "alba");
  const row = await saveDirect(secrets, "alba-open");
  assert.equal(row.botId, "alba");
  assert.deepEqual(holders(secrets), ["alba"]);
});

test("switching chats moves the open chat, so a save lands in the new chat's bot", async () => {
  const { chat, secrets } = exampleParts();
  const leaveAlba = openChat(chat, "alba");
  leaveAlba();
  openChat(chat, "iris");
  const row = await saveDirect(secrets, "switched");
  assert.equal(row.botId, "iris");
  assert.deepEqual(holders(secrets), ["iris"]);
});

test("leaving the chat clears the open chat, so a direct save is refused again", async () => {
  const { chat, secrets } = exampleParts();
  const leave = openChat(chat, "alba");
  await saveDirect(secrets, "before-leaving");
  leave();
  await assert.rejects(saveDirect(secrets, "after-leaving"), NOT_OPEN);
  assert.deepEqual(holders(secrets), ["alba"]);
});

test("a switch while a save is in flight refuses it as the active chat changed and saves nothing", async () => {
  const { chat, secrets } = exampleParts();
  const leave = openChat(chat, "alba");
  const saving = saveDirect(secrets, "in-flight");
  leave();
  openChat(chat, "iris");
  await assert.rejects(saving, CHANGED);
  assert.deepEqual(holders(secrets), []);
});

test("leaving while a save is in flight refuses it as the active chat changed and saves nothing", async () => {
  const { chat, secrets } = exampleParts();
  const leave = openChat(chat, "alba");
  const saving = saveDirect(secrets, "left-in-flight");
  leave();
  await assert.rejects(saving, CHANGED);
  assert.deepEqual(holders(secrets), []);
});

for (const [what, extra] of [
  ["a bot", { botId: "iris" }],
  ["a chat", { chatId: "chat-iris" }],
  ["an active chat", { activeChat: { id: "chat-iris", botId: "iris" } }],
]) {
  test("nothing a caller passes with a save chooses the chat: " + what + " beside the target is refused and saves nothing", async () => {
    const { chat, secrets } = exampleParts();
    openChat(chat, "alba");
    await assert.rejects(saveDirect(secrets, "chosen-" + Object.keys(extra)[0], extra), { name: "Refused", message: "Secret operation not allowed." });
    assert.deepEqual(holders(secrets), []);
  });
}

test("watching the chat list does not open a chat", async () => {
  const { chat, secrets } = exampleParts();
  chat.watchChats(() => undefined);
  await assert.rejects(saveDirect(secrets, "watch-only"), NOT_OPEN);
});

test("the open chat is its bot's, named chat- and the bot, and a caller's copy of it changes nothing", async () => {
  const { createOpenChat } = await load("src/data/open-chat.ts");
  const holder = createOpenChat();
  assert.equal(holder.current(), null);
  holder.enter("alba");
  assert.deepEqual(holder.current(), { id: "chat-alba", botId: "alba" });
  holder.current().botId = "iris";
  assert.deepEqual(holder.current(), { id: "chat-alba", botId: "alba" });
});

test("a late stop of an earlier chat cannot clear a chat opened after it, and each stop works once", async () => {
  const { createOpenChat } = await load("src/data/open-chat.ts");
  const holder = createOpenChat();
  const stopAlba = holder.enter("alba");
  const stopIris = holder.enter("iris");
  stopAlba();
  assert.deepEqual(holder.current(), { id: "chat-iris", botId: "iris" });
  stopIris();
  assert.equal(holder.current(), null);
  const again = holder.enter("iris");
  stopIris();
  assert.deepEqual(holder.current(), { id: "chat-iris", botId: "iris" });
  again();
  assert.equal(holder.current(), null);
});

test("through the lazy parts a save is refused until the chat code has loaded and the chat is open, then it lands", async () => {
  const parts = exampleParts();
  let arrive = () => undefined;
  const chatPart = new Promise((resolve) => {
    arrive = () => resolve(parts.chat);
  });
  const chat = lazyChat(() => chatPart);
  const secrets = lazySecrets(() => Promise.resolve(parts.secrets));
  const ready = new Promise((resolve) => {
    const stop = secrets.subscribe(() => {
      if (secrets.status() === "ready") {
        stop();
        resolve();
      }
    });
  });
  await ready;
  openChat(chat, "alba");
  await assert.rejects(saveDirect(secrets, "chat-code-loading"), NOT_OPEN);
  arrive();
  await chat.listChats();
  const row = await saveDirect(secrets, "chat-code-loaded");
  assert.equal(row.botId, "alba");
  assert.deepEqual(holders(secrets), ["alba"]);
});
