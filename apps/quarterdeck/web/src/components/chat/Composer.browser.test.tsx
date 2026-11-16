import "../../styles/index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import {
  createDraftStore,
  deviceStorage,
  DRAFTS_KEY,
  type DraftStore,
  saveOnLeave,
} from "../../stores/draftStore.ts";
import { Composer, LONG_PASTE_CHARS } from "./Composer.tsx";

interface Mounted {
  readonly root: Root;
  readonly host: HTMLElement;
}

interface HeapReading {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface Seen {
  pastes: number;
  readonly inputs: Array<string>;
}

const CHAT = "chat-iris";
const long = "Señor 日本語 😀 plain words. ".repeat(10_000).slice(0, 200_000);

const mounted: Array<Mounted> = [];
const leaving: Array<() => void> = [];
const stores: Array<DraftStore> = [];

afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.root.unmount();
    item.host.remove();
  }
  for (const stop of leaving.splice(0)) stop();
  for (const store of stores.splice(0)) store.flush();
  window.localStorage.clear();
});

const pause = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await pause(10);
  }
};

const reached = async (check: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await pause(10);
  }
  return true;
};

const frame = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return Promise.race([promise, pause(500)]);
};

const painted = async (): Promise<void> => {
  await frame();
  await frame();
};

const heap = (mark: string): void => {
  const reading = (performance as Performance & { readonly memory?: HeapReading }).memory;
  console.log(
    reading === undefined
      ? `heap ${mark}: no reading in this browser`
      : `heap ${mark}: used ${reading.usedJSHeapSize} total ${reading.totalJSHeapSize} limit ${reading.jsHeapSizeLimit}`,
  );
};

const say = async (line: string): Promise<void> => {
  console.log(line);
  await pause(50);
};

const newStore = (): DraftStore => {
  const drafts = createDraftStore(deviceStorage);
  stores.push(drafts);
  leaving.push(saveOnLeave(drafts));
  return drafts;
};

const mount = async (drafts: DraftStore): Promise<HTMLTextAreaElement> => {
  document.documentElement.dataset.look = "dark";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  root.render(<Composer chatId={CHAT} chatName="Iris" drafts={drafts} />);
  await until(() => host.querySelector("textarea") !== null);
  const box = host.querySelector("textarea");
  if (box === null) throw new Error("the message box did not appear");
  return box;
};

const watch = (box: HTMLTextAreaElement): Seen => {
  const seen: Seen = { pastes: 0, inputs: [] };
  box.addEventListener("paste", () => {
    seen.pastes += 1;
  });
  box.addEventListener("input", (event) => {
    seen.inputs.push(event.inputType);
  });
  return seen;
};

const draftOf = (drafts: DraftStore): string => drafts.state.getState().drafts.get(CHAT) ?? "";

const pasteByKeys = async (word: string, box: HTMLTextAreaElement, text: string): Promise<void> => {
  heap(`${word} before`);
  await say(`size ${word} ${text.length}`);
  await say(`step ${word}: click the box with the test tool`);
  await page.getByRole("textbox", { name: "Message Iris" }).click();
  await say(`step ${word}: write the clipboard`);
  await navigator.clipboard.writeText(text);
  heap(`${word} clipboard written`);
  await say(`step ${word}: focus the box`);
  box.focus();
  await painted();
  await say(`step ${word}: press the paste keys`);
  await userEvent.keyboard("{ControlOrMeta>}v{/ControlOrMeta}");
  heap(`${word} paste keys pressed`);
};

const pasteEvent = (text: string): ClipboardEvent => {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  return new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
};

it("catchfull: a real paste of 200,000 characters arrives whole through the catch", async () => {
  const word = "catchfull";
  const drafts = newStore();
  const box = await mount(drafts);
  const seen = watch(box);
  await pasteByKeys(word, box, long);
  const arrived = await reached(() => box.value.length === long.length);
  console.log(
    `${word} paste events ${seen.pastes}, input events ${seen.inputs.length}, box holds ${box.value.length}`,
  );
  expect(arrived).toBe(true);
  expect(box.value === long).toBe(true);
  expect(seen.pastes).toBe(1);
  expect(seen.inputs).toEqual([]);
  expect(box.selectionStart).toBe(long.length);
  expect(draftOf(drafts) === long).toBe(true);
  heap(`${word} pasted`);
  await say(`step ${word}: lay out and draw`);
  console.log(`${word} scrollHeight ${box.scrollHeight}`);
  await painted();
  await say(`step ${word}: press one arrow key`);
  await userEvent.keyboard("{ArrowLeft}");
  await until(() => box.selectionStart === long.length - 1);
  expect(box.value === long).toBe(true);
  heap(`${word} after`);
});

it("reload: the 200,000 pasted characters are in the box again after the page's state is thrown away", async () => {
  const word = "reload";
  const first = newStore();
  const box = await mount(first);
  await pasteByKeys(word, box, long);
  expect(await reached(() => box.value.length === long.length)).toBe(true);
  await say(`step ${word}: leave the page`);
  window.dispatchEvent(new Event("pagehide"));
  const stored = window.localStorage.getItem(DRAFTS_KEY) ?? "";
  console.log(`${word} stored text holds ${stored.length} characters`);
  for (const item of mounted.splice(0)) {
    item.root.unmount();
    item.host.remove();
  }
  for (const stop of leaving.splice(0)) stop();
  heap(`${word} state thrown away`);
  await say(`step ${word}: build the state again from the device's storage`);
  const second = newStore();
  expect(second).not.toBe(first);
  const again = await mount(second);
  expect(again).not.toBe(box);
  expect(again.value.length).toBe(long.length);
  expect(again.value === long).toBe(true);
  await painted();
  heap(`${word} after`);
});

it("browserway: a paste of 20,000 characters goes the browser's own way, and its undo works", async () => {
  const word = "browserway";
  const text = long.slice(0, LONG_PASTE_CHARS);
  const drafts = newStore();
  const box = await mount(drafts);
  const seen = watch(box);
  await pasteByKeys(word, box, text);
  const arrived = await reached(() => box.value.length === text.length);
  console.log(
    `${word} paste events ${seen.pastes}, input types ${[...new Set(seen.inputs)].join(" ")}, box holds ${box.value.length}`,
  );
  expect(arrived).toBe(true);
  expect(box.value === text).toBe(true);
  expect(seen.pastes).toBe(1);
  expect(seen.inputs).toEqual(["insertFromPaste"]);
  await until(() => draftOf(drafts).length === text.length);
  expect(draftOf(drafts) === text).toBe(true);
  await say(`step ${word}: press the undo keys`);
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  const undone = await reached(() => box.value === "");
  console.log(`${word} after undo: input types ${seen.inputs.join(" ")}, box holds ${box.value.length}`);
  expect(undone).toBe(true);
  expect(seen.inputs).toEqual(["insertFromPaste", "historyUndo"]);
  await until(() => draftOf(drafts) === "");
  heap(`${word} after`);
});

it("typedletter: one typed letter goes in beside 200,000 characters", async () => {
  const word = "typedletter";
  const drafts = newStore();
  drafts.setDraft(CHAT, long);
  const box = await mount(drafts);
  await until(() => box.value.length === long.length);
  const seen = watch(box);
  heap(`${word} before`);
  await say(`step ${word}: click the box with the test tool`);
  await page.getByRole("textbox", { name: "Message Iris" }).click();
  await say(`step ${word}: put the caret at the end`);
  box.focus();
  box.setSelectionRange(long.length, long.length);
  await painted();
  await say(`step ${word}: type one letter`);
  await userEvent.keyboard("x");
  const arrived = await reached(() => box.value.length === long.length + 1);
  console.log(`${word} input types ${seen.inputs.join(" ")}, box holds ${box.value.length}`);
  expect(arrived).toBe(true);
  expect(box.value === `${long}x`).toBe(true);
  expect(seen.inputs).toEqual(["insertText"]);
  await until(() => draftOf(drafts).length === long.length + 1);
  expect(draftOf(drafts) === `${long}x`).toBe(true);
  await painted();
  heap(`${word} after`);
});

it("eventtext: the catch reads 200,000 characters from the paste event itself", async () => {
  const word = "eventtext";
  const drafts = newStore();
  const box = await mount(drafts);
  const seen = watch(box);
  heap(`${word} before`);
  await say(`step ${word}: hand the box a paste event that holds the text`);
  const event = pasteEvent(long);
  box.focus();
  box.dispatchEvent(event);
  heap(`${word} event handled`);
  expect(event.defaultPrevented).toBe(true);
  expect(box.value === long).toBe(true);
  expect(box.selectionStart).toBe(long.length);
  expect(box.selectionEnd).toBe(long.length);
  expect(seen.pastes).toBe(1);
  expect(seen.inputs).toEqual([]);
  expect(draftOf(drafts) === long).toBe(true);
  await painted();
  heap(`${word} after`);
});

it("caretlines: a caught paste goes in at the caret, over the selection, with one line end for each line", async () => {
  const drafts = newStore();
  drafts.setDraft(CHAT, "before [chosen] after");
  const box = await mount(drafts);
  await until(() => box.value === "before [chosen] after");
  const pasted = `one\r\ntwo\rthree\n${"a".repeat(LONG_PASTE_CHARS)}`;
  const lines = `one\ntwo\nthree\n${"a".repeat(LONG_PASTE_CHARS)}`;
  box.focus();
  box.setSelectionRange(7, 15);
  const event = pasteEvent(pasted);
  box.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(box.value === `before ${lines} after`).toBe(true);
  expect(box.selectionStart).toBe(7 + lines.length);
  expect(box.selectionEnd).toBe(7 + lines.length);
  expect(draftOf(drafts) === `before ${lines} after`).toBe(true);
  const short = pasteEvent("a".repeat(LONG_PASTE_CHARS));
  box.dispatchEvent(short);
  expect(short.defaultPrevented).toBe(false);
});

it("leaveflush: a draft is kept at once when the page is left, before the save delay has passed", () => {
  const drafts = newStore();
  drafts.setDraft(CHAT, "kept at once");
  expect(window.localStorage.getItem(DRAFTS_KEY)).toBeNull();
  window.dispatchEvent(new Event("pagehide"));
  expect(window.localStorage.getItem(DRAFTS_KEY)).toBe(JSON.stringify({ [CHAT]: "kept at once" }));
});

it("signoutclear: clearing every draft removes the kept text from the device and empties the box", async () => {
  const drafts = newStore();
  const box = await mount(drafts);
  drafts.setDraft(CHAT, "to be cleared");
  drafts.flush();
  await until(() => box.value === "to be cleared");
  expect(window.localStorage.getItem(DRAFTS_KEY)).toBe(JSON.stringify({ [CHAT]: "to be cleared" }));
  drafts.setDraft(CHAT, "to be cleared, with one more word");
  drafts.clearAll();
  expect(window.localStorage.getItem(DRAFTS_KEY)).toBeNull();
  await until(() => box.value === "");
  await pause(400);
  expect(window.localStorage.getItem(DRAFTS_KEY)).toBeNull();
  expect(draftOf(newStore())).toBe("");
});
