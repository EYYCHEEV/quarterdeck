import { avatarColor, avatarSlot } from "../domain/avatar";
import { QUOTE_LIMIT, SEND_FAILED_TEXT, withinLimit } from "../domain/chat";
import { claimedType, EXPIRED_TEXT, FILES_OFF_TEXT, typeText, type FileLimits } from "../domain/files-r1";
import { plainText } from "../domain/markdown";
import type { Bot } from "../domain/types";
import type { Attachment, ChatFeature, ChatMessage, ChatRow, ChatThread, SentQuote, ServerUploadVerdict, Working, WireOutgoing } from "./chat-types";
import { NotConfirmed, Refused } from "./source";

export { bigText, typeText } from "../domain/files-r1";

type Raw = Record<string, unknown>;

export type ChatBot = { id: string; note: string; name?: string };

export type ChatListed = { bot: ChatBot; preview: string; at: string; last: string; unread: boolean; rev?: number };

export type ChatList = { rows: ChatListed[]; limits: FileLimits | null };

export type ChatRead = {
  bot: ChatBot;
  messages: ChatMessage[];
  older: boolean;
  seenUpTo: string | null;
  seenAt: string | null;
  working: Working | null;
  firstUnread: string | null;
  features: ChatFeature[];
  rev?: number;
};

export type ChatReadReceipt = { csrf: string; freshUntil: number };

export type ChatReceipt = ChatMessage & { uploadVerdicts: ServerUploadVerdict[]; csrf: string; freshUntil: number };

export type UploadReceipt = { id: string; name: string; type: string; size: number; kind: "photo" | "file"; csrf: string; freshUntil: number };

export const CHAT_WORDS = {
  bot: "This bot is not in your chat list.",
  text: "Message is empty or too long.",
  mail: SEND_FAILED_TEXT,
  files: FILES_OFF_TEXT,
  quote: "Not sent: quotes are not built on the server yet.",
  quoteGone: "Not sent: that message is no longer in this chat.",
  clientId: "Not sent: the message id is not 1 to 80 letters, digits, _ or -.",
  token: "Not sent: there is no sign-in token.",
  expired: EXPIRED_TEXT,
};

const BODY_LIMIT = 16384;
const MAX_ROWS = 200;
const MAX_MESSAGES = 50;
const MAX_ID = 512;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const BOT_ID = /^[\w.-]{1,64}$/;
const MAX_BOT_NAME = 40;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FEATURES: readonly string[] = ["quote", "read", "seen", "working", "files", "cursor"];
const MAX_FEATURES = 64;
const MAX_FILES = 50;
const MAX_NAME = 512;
const MAX_MIME = 255;
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILES_PATH = "/captain/api/files/";

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const unreadable = (what: string) => new Refused("The server's answer could not be read: " + what + ".");

function stringOf(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw unreadable(key);
  return value;
}

function messageIdOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_ID || CONTROL.test(value)) throw unreadable(what);
  return value;
}

function timeOf(value: unknown, what: string, empty: boolean): string {
  if (typeof value !== "string" || (value === "" ? !empty : Number.isNaN(Date.parse(value)))) throw unreadable(what);
  return value;
}

const nameOf = (value: unknown): string | undefined => (typeof value === "string" && value.length <= MAX_BOT_NAME * 2 && value.trim() !== "" && !CONTROL.test(value) && [...value].length <= MAX_BOT_NAME ? value : undefined);

function botParse(value: unknown): ChatBot {
  if (!isRecord(value)) throw unreadable("the bot");
  const { id, note } = value;
  if (typeof id !== "string" || !BOT_ID.test(id)) throw unreadable("a bot id");
  if (note !== undefined && typeof note !== "string") throw unreadable("the bot note");
  const name = nameOf(value.name);
  return name === undefined ? { id, note: note ?? "" } : { id, note: note ?? "", name };
}

function revOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unreadable("rev");
  return value;
}

const idOrNull = (value: unknown, what: string): string | null => (value === null ? null : messageIdOf(value, what));

const timeOrNull = (value: unknown, what: string): string | null => (value === null ? null : timeOf(value, what, false));

function boundedText(value: unknown, what: string): string {
  if (typeof value !== "string" || !withinLimit(value)) throw unreadable(what);
  return value;
}

function workingOf(value: unknown): Working | null {
  if (value === null) return null;
  if (!isRecord(value)) throw unreadable("working");
  return { note: boundedText(value.note, "the working note"), since: timeOf(value.since, "the working time", false), updatedAt: timeOf(value.updatedAt, "the working time", false) };
}

function featuresOf(value: unknown): ChatFeature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FEATURES) throw unreadable("features");
  const known = new Set<ChatFeature>();
  for (const name of value) {
    if (typeof name !== "string") throw unreadable("features");
    if (FEATURES.includes(name)) known.add(name as ChatFeature);
  }
  return [...known];
}

function quoteOf(value: unknown): SentQuote | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw unreadable("a quote");
  const card = "cardId" in value || "version" in value;
  if (card === ("id" in value || "from" in value || "at" in value || "text" in value)) throw unreadable("a quote");
  if (card) {
    const { cardId, version } = value;
    if (typeof cardId !== "string" || !CARD_ID.test(cardId) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw unreadable("a card quote");
    return { cardId, version };
  }
  const from = value.from;
  if (from !== "captain" && from !== "bot") throw unreadable("a quote sender");
  return { id: messageIdOf(value.id, "a quote id"), from, at: timeOf(value.at, "a quote time", false), text: boundedText(value.text, "a quote text") };
}

function fileOf(item: unknown): Attachment | null {
  if (!isRecord(item)) return null;
  const { id, name, type, size, kind, url, sha256 } = item;
  if (typeof id !== "string" || !FILE_ID.test(id)) return null;
  if (typeof name !== "string" || name === "" || name.length > MAX_NAME) return null;
  if (typeof type !== "string" || type.length > MAX_MIME) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
  if (sha256 !== undefined && (typeof sha256 !== "string" || !SHA256.test(sha256))) return null;
  if (kind === "blocked") return url === undefined ? { id, name, size, type, kind, url: "" } : null;
  if ((kind !== "photo" && kind !== "file") || url !== FILES_PATH + id) return null;
  return { id, name, size, type, kind, url };
}

function filesOf(value: unknown): Attachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw unreadable("files");
  const kept: Attachment[] = [];
  for (const item of value) {
    if (kept.length === MAX_FILES) break;
    const file = fileOf(item);
    if (file) kept.push(file);
  }
  return kept.length === 0 ? undefined : kept;
}

function messageOf(raw: unknown): ChatMessage {
  if (!isRecord(raw)) throw unreadable("a message");
  const from = raw.from;
  if (from !== "captain" && from !== "bot") throw unreadable("the sender");
  const refs = raw.refs;
  if (!Array.isArray(refs) || !refs.every((ref): ref is string => typeof ref === "string")) throw unreadable("refs");
  const clientId = raw.clientId;
  if (clientId !== undefined && typeof clientId !== "string") throw unreadable("clientId");
  const made: ChatMessage = { id: messageIdOf(raw.id, "a message id"), from, text: stringOf(raw, "text"), at: timeOf(raw.at, "a message time", false), refs };
  if (clientId !== undefined) made.clientId = clientId;
  const quote = quoteOf(raw.quote);
  if (quote !== undefined) made.quote = quote;
  const attachments = filesOf(raw.files);
  if (attachments !== undefined) made.attachments = attachments;
  return made;
}

export function parseChatRows(body: unknown): ChatListed[] {
  if (!Array.isArray(body) || body.length > MAX_ROWS) throw unreadable("the chat list");
  return body.map((item): ChatListed => {
    if (!isRecord(item)) throw unreadable("a chat row");
    if (typeof item.unread !== "boolean") throw unreadable("unread");
    const last = item.last;
    const made: ChatListed = { bot: botParse(item.bot), preview: stringOf(item, "preview"), at: timeOf(item.at, "a row time", true), last: last === "" ? "" : messageIdOf(last, "last"), unread: item.unread };
    const rev = revOf(item.rev);
    if (rev !== undefined) made.rev = rev;
    return made;
  });
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function limitsOf(value: unknown): FileLimits {
  if (!isRecord(value)) throw unreadable("the file limits");
  const { fileBytes, messageBytes, count } = value;
  if (!positive(fileBytes) || !positive(messageBytes) || !positive(count)) throw unreadable("the file limits");
  return { fileBytes, messageBytes, count };
}

export function parseChatList(body: unknown): ChatList {
  if (Array.isArray(body)) return { rows: parseChatRows(body), limits: null };
  if (!isRecord(body) || !Array.isArray(body.chats)) throw unreadable("the chat list");
  return { rows: parseChatRows(body.chats), limits: limitsOf(body.fileLimits) };
}

export function parseChatThread(body: unknown): ChatRead {
  if (!isRecord(body)) throw unreadable("the thread");
  const { messages, older, firstUnread } = body;
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || typeof older !== "boolean") throw unreadable("the thread");
  const made: ChatRead = {
    bot: botParse(body.bot),
    messages: messages.map(messageOf),
    older,
    seenUpTo: idOrNull(body.seenUpTo, "seenUpTo"),
    seenAt: timeOrNull(body.seenAt, "seenAt"),
    working: workingOf(body.working),
    firstUnread: firstUnread === undefined ? null : idOrNull(firstUnread, "firstUnread"),
    features: featuresOf(body.features),
  };
  const rev = revOf(body.rev);
  if (rev !== undefined) made.rev = rev;
  return made;
}

export function chatReceiptOf(raw: unknown, clientId: string): ChatReceipt {
  if (!isRecord(raw)) throw new NotConfirmed();
  let message: ChatMessage;
  try {
    message = messageOf(raw);
  } catch {
    throw new NotConfirmed();
  }
  const { uploadVerdicts, csrf, freshUntil } = raw;
  if (message.from !== "captain" || message.clientId !== clientId || !Array.isArray(uploadVerdicts) || uploadVerdicts.length !== 0) throw new NotConfirmed();
  if (typeof csrf !== "string" || typeof freshUntil !== "number" || !Number.isFinite(freshUntil)) throw new NotConfirmed();
  return { ...message, uploadVerdicts: [], csrf, freshUntil };
}

function wireQuoteOk(quote: unknown): boolean {
  if (!isRecord(quote) || Object.keys(quote).length !== 2) return false;
  if ("cardId" in quote) return typeof quote.cardId === "string" && CARD_ID.test(quote.cardId) && typeof quote.version === "number" && Number.isSafeInteger(quote.version) && quote.version >= 1;
  const { id, text } = quote;
  return typeof id === "string" && id !== "" && id.length <= MAX_ID && !CONTROL.test(id) && typeof text === "string" && text !== "" && text.length <= QUOTE_LIMIT * 2 && [...text].length <= QUOTE_LIMIT;
}

export function checkWords(botId: string, outgoing: Pick<WireOutgoing, "text" | "clientId" | "quote">, withFiles: boolean): void {
  if (typeof botId !== "string" || !BOT_ID.test(botId)) throw new Refused(CHAT_WORDS.bot);
  if (outgoing.quote !== undefined && !wireQuoteOk(outgoing.quote)) throw new Refused(CHAT_WORDS.quoteGone);
  if (typeof outgoing.text !== "string" || (outgoing.text.length === 0 && !withFiles) || !withinLimit(outgoing.text)) throw new Refused(CHAT_WORDS.text);
  if (typeof outgoing.clientId !== "string" || !CLIENT_ID.test(outgoing.clientId)) throw new Refused(CHAT_WORDS.clientId);
}

export function checkOutgoing(botId: string, outgoing: WireOutgoing): void {
  const files: unknown = outgoing.files;
  if (files !== undefined && (!Array.isArray(files) || files.length > MAX_FILES || !files.every((id) => typeof id === "string" && FILE_ID.test(id)))) throw new Refused(CHAT_WORDS.files);
  checkWords(botId, outgoing, Array.isArray(files) && files.length > 0);
}

export function chatBody(botId: string, outgoing: WireOutgoing, csrf: string): string {
  if (typeof csrf !== "string" || csrf === "") throw new Refused(CHAT_WORDS.token);
  const json = JSON.stringify({ bot: botId, text: outgoing.text, clientId: outgoing.clientId, csrf, ...(outgoing.quote === undefined ? {} : { quote: outgoing.quote }), ...(outgoing.files?.length ? { files: outgoing.files } : {}) });
  if (new TextEncoder().encode(json).length > BODY_LIMIT) throw new Refused(CHAT_WORDS.text);
  return json;
}

export function checkRead(botId: string, upTo: string): void {
  if (typeof botId !== "string" || !BOT_ID.test(botId)) throw new Refused(CHAT_WORDS.bot);
  if (typeof upTo !== "string" || upTo === "" || upTo.length > MAX_ID || CONTROL.test(upTo)) throw new Refused(CHAT_WORDS.mail);
}

export function readBody(botId: string, upTo: string, csrf: string): string {
  checkRead(botId, upTo);
  if (typeof csrf !== "string" || csrf === "") throw new Refused(CHAT_WORDS.token);
  return JSON.stringify({ bot: botId, upTo, csrf });
}

export function readReceiptOf(raw: unknown): ChatReadReceipt {
  if (!isRecord(raw)) throw new NotConfirmed();
  const { csrf, freshUntil } = raw;
  if (typeof csrf !== "string" || typeof freshUntil !== "number" || !Number.isFinite(freshUntil)) throw new NotConfirmed();
  return { csrf, freshUntil };
}

export function uploadReceiptOf(raw: unknown): UploadReceipt {
  if (!isRecord(raw)) throw new NotConfirmed();
  const { id, name, type, size, kind, csrf, freshUntil } = raw;
  if (typeof id !== "string" || !FILE_ID.test(id) || typeof name !== "string" || name === "" || name.length > MAX_NAME || typeof type !== "string" || type.length > MAX_MIME) throw new NotConfirmed();
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || (kind !== "photo" && kind !== "file")) throw new NotConfirmed();
  if (typeof csrf !== "string" || csrf === "" || typeof freshUntil !== "number" || !Number.isFinite(freshUntil)) throw new NotConfirmed();
  return { id, name, type, size, kind, csrf, freshUntil };
}

export function uploadType(file: { name: string; type: string }): string {
  const type = claimedType(file.name, file.type);
  if (type === null) throw new Refused(typeText(file.name));
  return type;
}

export function botOf(bot: ChatBot, order: number): Bot {
  return { id: bot.id, name: bot.name ?? bot.id, role: bot.note, color: avatarColor(avatarSlot(bot.id)), pinned: false, order };
}

export const botsOf = (listed: ChatListed[]): Bot[] => listed.map((item, order) => botOf(item.bot, order));

export const rowsOf = (listed: ChatListed[]): ChatRow[] => listed.map((item, order) => ({ bot: botOf(item.bot, order), preview: plainText(item.preview), at: item.at, unread: item.unread }));

export const threadOf = (read: ChatRead, order = 0, limits: FileLimits | null = null): ChatThread => ({
  bot: botOf(read.bot, order),
  messages: read.messages,
  seenUpTo: read.seenUpTo,
  seenAt: read.seenAt,
  working: read.working,
  older: read.older,
  firstUnread: read.firstUnread,
  features: read.features,
  ...(limits === null ? {} : { fileLimits: limits }),
});

export function mergeOlder(held: ChatRead, page: ChatRead): ChatRead {
  const known = new Set(held.messages.map((one) => one.id));
  return { ...held, messages: [...page.messages.filter((one) => !known.has(one.id)), ...held.messages], older: page.older };
}

export function mergeNewest(held: ChatRead | null, page: ChatRead): ChatRead {
  if (!held) return page;
  const inPage = new Set(page.messages.map((one) => one.id));
  const shared = held.messages.findIndex((one) => inPage.has(one.id));
  if (shared < 0) return page;
  return { ...page, messages: [...held.messages.slice(0, shared), ...page.messages], older: shared > 0 ? held.older : page.older };
}

export function mergeAfter(held: ChatRead, after: string, answer: ChatRead): ChatRead {
  const fresh = new Set(answer.messages.map((one) => one.id));
  const at = held.messages.findIndex((one) => one.id === after);
  const kept = (at < 0 ? held.messages : held.messages.slice(0, at + 1)).filter((one) => !fresh.has(one.id));
  return { ...answer, messages: [...kept, ...answer.messages], older: held.older };
}

export function appendSent(held: ChatRead, sent: ChatMessage): ChatRead {
  return held.messages.some((one) => one.id === sent.id) ? held : { ...held, messages: [...held.messages, sent] };
}

export function keepSent(read: ChatRead, mine: ChatMessage[]): ChatRead {
  const missing = mine.filter((one) => !read.messages.some((held) => held.id === one.id || (one.clientId !== undefined && held.clientId === one.clientId)));
  if (missing.length === 0) return read;
  const messages = [...read.messages];
  for (const one of missing) {
    const after = messages.findIndex((held) => Date.parse(held.at) > Date.parse(one.at));
    messages.splice(after < 0 ? messages.length : after, 0, one);
  }
  return { ...read, messages };
}

export const needsThread = (row: { last: string }, held: ChatRead): boolean => row.last !== "" && !held.messages.some((one) => one.id === row.last);

export const threadStale = (row: { last: string; rev?: number }, held: ChatRead): boolean => needsThread(row, held) || (row.rev !== undefined && row.rev !== held.rev);

export function threadPath(botId: string, before?: string): string {
  if (typeof botId !== "string" || !BOT_ID.test(botId)) throw new Refused(CHAT_WORDS.bot);
  const page = before === undefined ? "" : "&before=" + encodeURIComponent(messageIdOf(before, "a message id"));
  return "/captain/api/chat?bot=" + encodeURIComponent(botId) + page;
}

export function newerPath(botId: string, after: string): string {
  return threadPath(botId) + "&after=" + encodeURIComponent(messageIdOf(after, "a message id"));
}

export class CursorGone extends Error {
  constructor() {
    super("the server no longer knows that message");
    this.name = "CursorGone";
  }
}
