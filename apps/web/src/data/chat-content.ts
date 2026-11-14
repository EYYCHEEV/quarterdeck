import { mailQuote, messageQuote, readableText, type QuoteRange, type SentQuote } from "../domain/chat";
import type { FileLimits } from "../domain/files-r1";
import type { Attachment, ChatMessage, Working } from "./chat-types";
import { BOTS } from "./example-content";
import { mediaPath } from "./media";
import { MAIL_THREADS, type PackArtifact } from "./pack-extra";

type RawAttachment = { id: string; kind: "picture" | "file"; server?: "photo" | "file" | "blocked"; name: string; mime: string; file?: string; width?: number; height?: number; bytes: number; alt?: string; text?: string };

type RawQuote = { kind: "message"; messageId: string; from: string; text: string; whole: boolean; range?: QuoteRange } | { kind: "taskCard"; card: string; version: number } | { kind: "mail"; ref: string };

export type RawMessage = {
  id: string;
  from: string;
  at: string;
  text: string;
  attachments?: RawAttachment[];
  quote?: RawQuote;
  cardRefs?: string[];
  cardUpdate?: { card: string; version: number; line: string };
  mailRefs?: string[];
  pageRefs?: string[];
  artifactRefs?: string[];
};

export type ChatContent = {
  chats: Record<string, { messagesAdd: RawMessage[]; set: { lastSeenByBot?: string } }>;
  seenAt: Record<string, string>;
  working: Record<string, { messageId: string; since: string; noteUpdatedAt: string; note: string }>;
  existingMessageFixes?: Record<string, { text: { now: string } }>;
};

export type ChatFixture = { fixture: string; bot: string; message?: RawMessage; messages?: RawMessage[]; artifactAdd?: PackArtifact; fileLimits?: FileLimits };

export type ChatFixtureFile = { fixtures: ChatFixture[] };

export type ChatSeed = {
  messages: Record<string, ChatMessage[]>;
  seen: Record<string, { id: string; at: string | null }>;
  working: Record<string, Working>;
  unread: string[];
};

type Base = { unread: boolean; seen: string | null; messages: RawMessage[] };

const BASE: Record<string, Base> = {
  "iris": {
    unread: false,
    seen: "iris-m3",
    messages: [
      { id: "iris-m1", from: "Captain", text: "Did the build pass last night?", at: "2026-11-02T13:25:00.000Z" },
      {
        id: "iris-m2",
        from: "Iris",
        text: "Yes. Everything passed. Two cards need a pick: c1 and c2.\n\nThe command I ran:\n\n```bash\nnpm run build:app && npm run test:chat && npm run design:check\n```\n\n- Build: passed\n- Tests: passed\n- **Next:** your pick on c1",
        at: "2026-11-02T13:30:00.000Z",
        mailRefs: ["MT-103"],
        pageRefs: ["PG-1"],
        artifactRefs: ["AR-2"],
      },
      { id: "iris-m3", from: "Captain", text: "Pick A on c1. I will look at c2 later.", at: "2026-11-02T14:00:00.000Z" },
    ],
  },
  "alba": { unread: true, seen: null, messages: [{ id: "alba-m1", from: "Alba", text: "The flow page is ready for your feedback.", at: "2026-11-02T14:48:00.000Z" }] },
  "dr-kivo": { unread: false, seen: null, messages: [{ id: "dr-kivo-m1", from: "Dr. Kivo", text: "Add bot token ends in 10 min.", at: "2026-11-02T13:55:00.000Z" }] },
  shelvorn: { unread: true, seen: null, messages: [{ id: "shelvorn-m1", from: "Shelvorn", text: "Draft is ready for review.", at: "2026-11-01T13:00:00.000Z" }] },
  "dale": { unread: false, seen: null, messages: [{ id: "dale-m1", from: "Dale", text: "Nothing to report.", at: "2026-10-29T14:00:00.000Z" }] },
};

const BASE_OWN: ReadonlySet<RawMessage> = new Set([BASE["iris"].messages[0], BASE["iris"].messages[2]]);
const NO_OWN: ReadonlySet<RawMessage> = new Set();
const isOwn = (message: RawMessage, own: ReadonlySet<RawMessage>) => BASE_OWN.has(message) || own.has(message);

const MAILS = new Map(MAIL_THREADS.flatMap((thread) => thread.mails.map((mail) => [mail.ref, mail] as const)));

const byTime = (a: RawMessage, b: RawMessage) => Date.parse(a.at) - Date.parse(b.at);

const FIXTURE_MEDIA = __QD_FIXTURES__ ? new Map(Array.from({ length: 8 }, (_, n) => ["../evidence/media/fixture-picture-" + (n + 1) + ".png", "fixture-picture-" + (n + 1) + ".png"])) : null;

function attachmentOf(raw: RawAttachment, media: string, fixture: boolean): Attachment {
  if (raw.server === "blocked") return { id: raw.id, name: raw.name, size: raw.bytes, type: raw.mime, url: "", kind: "blocked" };
  const mapped = fixture && raw.file !== undefined ? FIXTURE_MEDIA?.get(raw.file) : undefined;
  const kind = raw.kind === "picture" ? "image" : "file";
  const base = media === "" ? "chat/media/" : "/chat/media/";
  const url = raw.file === undefined
    ? URL.createObjectURL(new Blob([raw.text ?? ""], { type: raw.mime }))
    : mapped
      ? mediaPath(mapped, kind, media === "" ? "evidence/media/" : "/evidence/media/")
      : mediaPath(raw.file, kind, base);
  return { id: raw.id, name: raw.name, size: raw.bytes, type: raw.mime, url, ...(raw.alt ? { alt: raw.alt } : {}), ...(raw.server ? { kind: raw.server } : {}) };
}

function quoteOf(raw: RawQuote, list: Map<string, RawMessage | null>, botName: string, own: ReadonlySet<RawMessage>): SentQuote | undefined {
  if (raw.kind === "taskCard") return { cardId: raw.card, version: raw.version };
  if (raw.kind === "mail") {
    const mail = MAILS.get(raw.ref);
    return mail ? mailQuote(mail) : undefined;
  }
  const fallback = { label: "Quoted by " + botName + "; not found in this chat", title: null, text: raw.text, to: null };
  const quoted = list.get(raw.messageId);
  if (!quoted) return fallback;
  const who = isOwn(quoted, own) ? "You" : botName;
  const matchesAuthor = who === "You" ? raw.from === "Captain" || raw.from === "You" : raw.from === who;
  const canonical = readableText(quoted.text);
  const range = raw.range;
  const selected = range && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= canonical.length ? canonical.slice(range.start, range.end) : null;
  const matchesText = raw.whole ? raw.text === canonical : selected !== null && selected === raw.text;
  if (!matchesAuthor || !matchesText) return fallback;
  return messageQuote({ id: quoted.id, who, at: quoted.at, text: quoted.text, selected: raw.whole ? null : selected, range: raw.whole ? undefined : range });
}

function chatOf(raws: RawMessage[], media: string, botId: string, own: ReadonlySet<RawMessage>, fixture = false): ChatMessage[] {
  const botName = BOTS.find((bot) => bot.id === botId)?.name ?? "Bot";
  const list = new Map<string, RawMessage | null>();
  for (const raw of raws) list.set(raw.id, list.has(raw.id) ? null : raw);
  return raws.map((raw) => {
    const quote = raw.quote ? quoteOf(raw.quote, list, botName, own) : undefined;
    return {
      id: raw.id,
      from: isOwn(raw, own) ? "captain" : "bot",
      text: raw.text,
      at: raw.at,
      refs: [...(raw.mailRefs ?? []), ...(raw.pageRefs ?? []), ...(raw.artifactRefs ?? [])],
      ...(raw.cardRefs ? { cardRefs: raw.cardRefs } : {}),
      ...(raw.cardUpdate ? { cardUpdate: { cardId: raw.cardUpdate.card, version: raw.cardUpdate.version, line: raw.cardUpdate.line } } : {}),
      ...(quote ? { quote } : {}),
      ...(raw.attachments?.length ? { attachments: raw.attachments.map((attachment) => attachmentOf(attachment, media, fixture)) } : {}),
    };
  });
}

export function seedChats(content: ChatContent, media: string, own: ReadonlySet<RawMessage> = NO_OWN): ChatSeed {
  const seed: ChatSeed = { messages: {}, seen: {}, working: {}, unread: [] };
  const fixes = content.existingMessageFixes ?? {};
  for (const [botId, base] of Object.entries(BASE)) {
    const added = content.chats[botId];
    const fixed = base.messages.map((message) => (fixes[message.id] && !isOwn(message, own) ? { ...message, text: fixes[message.id].text.now } : message));
    seed.messages[botId] = chatOf([...fixed, ...(added?.messagesAdd ?? [])].sort(byTime), media, botId, own);
    const mark = added?.set.lastSeenByBot ?? base.seen;
    if (mark) seed.seen[botId] = { id: mark, at: content.seenAt[mark] ?? null };
    if (base.unread) seed.unread.push(botId);
  }
  for (const [botId, note] of Object.entries(content.working)) seed.working[botId] = { note: note.note, since: note.since, updatedAt: note.noteUpdatedAt };
  return seed;
}

export function chatFixture(file: ChatFixtureFile, id: string): ChatFixture | null {
  return file.fixtures.find((entry) => entry.fixture.split(" ")[0] === id) ?? null;
}

export function fixtureMessages(fixture: ChatFixture, media: string, own: ReadonlySet<RawMessage> = NO_OWN): ChatMessage[] | null {
  const raws = [...(fixture.message ? [fixture.message] : []), ...(fixture.messages ?? [])];
  return raws.length ? chatOf(raws.sort(byTime), media, fixture.bot, own, true) : null;
}

export type Script = { botId: string; afterMs: number; note: string } | { botId: string; afterMs: number; reply: string };

export const FIXTURE_SCRIPTS: Record<string, Script[]> = __QD_FIXTURES__ ? {
  "CF-1": [
    { botId: "iris", afterMs: 30_000, note: "writing the reply on c1" },
    { botId: "iris", afterMs: 720_000, reply: "Picked A on c1. I left c2 open for later." },
  ],
} : {};
