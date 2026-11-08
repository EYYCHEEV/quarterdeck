import { rowPreview } from "../domain/chat-row";
import { cachedInspection, FILE_LIMIT_TEXT, MAX_FILES } from "../domain/file-inspection";
import type { Bot } from "../domain/types";
import { fixtureMessages, type Script } from "./chat-content";
import { appChatHistory, type FixtureHistory } from "./chat-history";
import type { Attachment, BrowserChatApi, BrowserUploadVerdict, ChatFeature, ChatMessage, ChatRow, ChatThread, SentChatMessage, Working } from "./chat-types";
import { BOTS } from "./example-content";
import type { OpenChatHolder } from "./open-chat";

export type ExampleOptions = {
  now?: () => number;
  latency?: () => number;
  schedule?: (run: () => void, ms: number) => () => void;
  failSend?: (attempt: number) => boolean;
  failList?: (attempt: number) => boolean;
  seenAfter?: number;
  workingAfter?: number;
  replyAfter?: number;
  media?: string;
  fixture?: FixtureHistory | Promise<FixtureHistory | null> | null;
  script?: Script[];
  openChat?: OpenChatHolder;
};

const WORKING_NOTE = "reading your message";

const FEATURES: ChatFeature[] = ["quote", "seen", "working", "files"];

const REPLIES = [
  "Seen. I will check it and come back with the details.\n\nFor now, the open card is c2.",
  "Done. The command I ran:\n\n```\nnpm run build:app\n```\n\n- Build: passed\n- Tests: passed\n- **Next:** your pick on c1",
  "Thanks. I noted it on c4 and left the rest open. More in [the example notes](https://example.com/notes).",
];

const defaultSchedule = (run: () => void, ms: number) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

const defaultLatency = () => 80 + Math.random() * 220;


export function createExampleChat(options: ExampleOptions = {}): BrowserChatApi {
  const now = options.now ?? Date.now;
  const latency = options.latency ?? defaultLatency;
  const schedule = options.schedule ?? defaultSchedule;
  const failSend = options.failSend ?? (() => false);
  const failList = options.failList ?? (() => false);
  const seenAfter = options.seenAfter ?? 700;
  const workingAfter = options.workingAfter ?? 1400;
  const replyAfter = options.replyAfter ?? 3200;
  const media = options.media ?? "/";
  const messages = new Map<string, ChatMessage[]>();
  const seen = new Map<string, string>();
  const seenAt = new Map<string, string>();
  const working = new Map<string, Working>();
  const unread = new Set<string>();
  const listeners = new Map<string, Set<(thread: ChatThread) => void>>();
  const watchers = new Set<() => void>();
  const delivered = new Map<string, SentChatMessage<BrowserUploadVerdict>>();
  let attempts = 0;
  let listings = 0;
  let replies = 0;

  const stamp = () => new Date(now()).toISOString();
  const botOf = (id: string): Bot => {
    const bot = BOTS.find((item) => item.id === id);
    if (!bot) throw new Error("No bot named " + id);
    return bot;
  };
  const threadOf = (id: string, firstUnread: string | null = null): ChatThread => ({
    bot: botOf(id),
    messages: [...(messages.get(id) ?? [])],
    seenUpTo: seen.get(id) ?? null,
    seenAt: seenAt.get(id) ?? null,
    working: working.get(id) ?? null,
    firstUnread,
    features: FEATURES,
  });
  const firstUnreadOf = (id: string): string | null => {
    if (!unread.has(id)) return null;
    let first: string | null = null;
    for (const message of messages.get(id) ?? []) {
      if (message.from === "captain") first = null;
      else if (first === null) first = message.id;
    }
    return first;
  };
  const notify = (id: string) => {
    const thread = threadOf(id);
    listeners.get(id)?.forEach((listener) => listener(thread));
    watchers.forEach((watcher) => watcher());
  };
  const append = (botId: string, message: ChatMessage) => {
    messages.set(botId, [...(messages.get(botId) ?? []), message]);
  };
  let ready = false;
  const loaded = Promise.all([appChatHistory(media), options.fixture ?? null]).then(([seed, loadedFixture]) => {
    const fixture = loadedFixture?.fixture;
    for (const [botId, list] of Object.entries(seed.messages)) messages.set(botId, list);
    for (const [botId, mark] of Object.entries(seed.seen)) {
      seen.set(botId, mark.id);
      if (mark.at) seenAt.set(botId, mark.at);
    }
    for (const [botId, state] of Object.entries(seed.working)) working.set(botId, state);
    for (const botId of seed.unread) unread.add(botId);
    const replaced = loadedFixture ? fixtureMessages(loadedFixture.fixture, media, loadedFixture.own) : null;
    if (fixture && replaced) {
      messages.set(fixture.bot, replaced);
      seen.delete(fixture.bot);
      seenAt.delete(fixture.bot);
      working.delete(fixture.bot);
    }
    for (const step of options.script ?? [])
      schedule(() => {
        if ("reply" in step) {
          working.delete(step.botId);
          append(step.botId, { id: step.botId + "-script-" + step.afterMs, from: "bot", text: step.reply, at: stamp(), refs: [] });
        } else {
          const before = working.get(step.botId);
          if (!before) return;
          working.set(step.botId, { ...before, note: step.note, updatedAt: stamp() });
        }
        notify(step.botId);
      }, step.afterMs);
    ready = true;
  });
  const later = <T,>(value: () => T | Promise<T>): Promise<T> => {
    const run = () =>
      new Promise<T>((resolve, reject) => {
        schedule(() => {
          try {
            resolve(value());
          } catch (error) {
            reject(error);
          }
        }, latency());
      });
    return ready ? run() : loaded.then(run);
  };
  const attachments = (clientId: string, checked: { file: File }[]): Attachment[] =>
    checked.map(({ file }, n) => ({ id: clientId + "-file-" + n, name: file.name, size: file.size, type: file.type, url: URL.createObjectURL(file) }));

  return {
    uploadBoundary: "browser-stand-in",
    listChats: () =>
      later(() => {
        listings += 1;
        if (failList(listings)) throw new Error("No reply from the server");
        return BOTS.filter((bot) => !bot.removedAt).map((bot): ChatRow => {
          const list = messages.get(bot.id) ?? [];
          const last = list[list.length - 1];
          return { bot, preview: last ? rowPreview(last) : "", at: last ? last.at : stamp(), unread: unread.has(bot.id) };
        }).sort((a, b) => b.at.localeCompare(a.at));
      }),
    watchChats: (onChange) => {
      watchers.add(onChange);
      return () => {
        watchers.delete(onChange);
      };
    },
    openThread: (botId) =>
      later(() => {
        const first = firstUnreadOf(botId);
        unread.delete(botId);
        const thread = threadOf(botId, first);
        watchers.forEach((watcher) => watcher());
        return thread;
      }),
    subscribe: (botId, onChange) => {
      const set = listeners.get(botId) ?? new Set();
      set.add(onChange);
      listeners.set(botId, set);
      const leave = options.openChat?.enter(botId);
      return () => {
        set.delete(onChange);
        leave?.();
      };
    },
    send: (botId, { text, clientId, quote, files }) =>
      later(async () => {
        botOf(botId);
        attempts += 1;
        if (failSend(attempts)) throw new Error("No reply from the server");
        const earlier = delivered.get(clientId);
        if (earlier) return earlier;
        if ((files?.length ?? 0) > MAX_FILES) throw new Error(FILE_LIMIT_TEXT);
        const inspected: { file: File; detectedType: string }[] = [];
        for (const file of files ?? []) {
          const proof = cachedInspection(file);
          if (!proof) throw new Error("Files must be checked before sending.");
          const check = await proof;
          if (!check.ok) throw new Error(check.reason);
          inspected.push(check);
        }
        const raced = delivered.get(clientId);
        if (raced) return raced;
        const message: SentChatMessage<BrowserUploadVerdict> = {
          id: botId + "-sent-" + clientId,
          clientId,
          from: "captain",
          text,
          at: stamp(),
          refs: [],
          uploadVerdicts: inspected.map(({ file, detectedType }): BrowserUploadVerdict => ({ filename: file.name, detectedType, checkedBy: "browser-stand-in", serverRecheckRequired: true })),
          ...(quote ? { quote } : {}),
          ...(inspected.length ? { attachments: attachments(clientId, inspected) } : {}),
        };
        delivered.set(clientId, message);
        append(botId, message);
        notify(botId);
        schedule(() => {
          seen.set(botId, message.id);
          seenAt.set(botId, stamp());
          notify(botId);
        }, seenAfter);
        schedule(() => {
          const at = stamp();
          working.set(botId, { note: WORKING_NOTE, since: working.get(botId)?.since ?? at, updatedAt: at });
          notify(botId);
        }, workingAfter);
        schedule(() => {
          working.delete(botId);
          append(botId, { id: botId + "-reply-" + clientId, from: "bot", text: REPLIES[replies % REPLIES.length], at: stamp(), refs: [] });
          replies += 1;
          if (!listeners.get(botId)?.size) unread.add(botId);
          notify(botId);
        }, replyAfter);
        return message;
      }),
  };
}
