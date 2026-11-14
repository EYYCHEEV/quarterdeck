import { watchEvents, type EventConnection, type EventStream } from "../platform/events";
import { readText } from "../platform/read-text";
import { schedule as later, type Schedule } from "../platform/timer";
import { answerBody, answerReceiptOf, checkAnswer, checkComment, commentBody, commentReceiptOf, tokenOf, type AnswerPost, type CommentPost, type CommentReceipt } from "./answer-body";
import type { CardFields } from "./card";
import type { MailListing, MailRead } from "./mail-client";
import type { ChatList, ChatRead, ChatReceipt, UploadReceipt } from "./chat-client";
import type { WireOutgoing } from "./chat-types";
import { FreshSignInRequired, NotConfirmed, RateLimited, Refused, SignInRequired, TimedOut } from "./source";
export { SignInRequired } from "./source";

export class NotFound extends Error {
  constructor() {
    super("not found");
    this.name = "NotFound";
  }
}

export class Unavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Unavailable";
  }
}

export type ListedAnswer = { pick: string; at: string };

export type ListedCard = {
  id: string;
  title: string;
  project: string;
  lane: string;
  due: string | null;
  state: "open" | "done" | "withdrawn";
  changedAt: string;
  from?: string;
  rev?: number;
  answer?: ListedAnswer | null;
  waitsOn?: string | null;
};

export type CardListing = { cards: ListedCard[]; truncated: boolean };

export type CardEvent =
  | { kind: "card" | "update" | "comment" | "withdraw"; sender: string; sent: string }
  | { kind: "answer"; sender: string; sent: string; pick: string; rev: number; note: string | null; forComment: boolean };

export type CardRead = { card: CardFields; rev: number; state: ListedCard["state"]; thread: CardEvent[] };

export type Send = (path: string, init: RequestInit) => Promise<Response>;

export type AnswerSent = { message: string; stale: boolean; rev: number };

export type SessionRequest = { kind: "list" | "card" | "token" | "mail" | "chat" | "bots" | "post"; automatic: boolean; sent?: number; wait?: boolean };

export type TokenList = (listing: CardListing, sent: number | undefined) => void;

export type EventLists = { cards: boolean; mail: boolean; chats?: boolean };

export type SessionControl = {
  request: (request: SessionRequest, send: () => Promise<Response>) => Promise<Response>;
};

export type ChatChain = { csrf: string | null };

export type ChatClient = {
  rows: (automatic: boolean) => Promise<ChatList>;
  thread: (bot: string, before: string | undefined, automatic: boolean) => Promise<ChatRead>;
  newer: (bot: string, after: string, automatic: boolean) => Promise<ChatRead>;
  send: (bot: string, outgoing: WireOutgoing, onList?: TokenList, chain?: ChatChain) => Promise<ChatReceipt>;
  read: (bot: string, upTo: string, onList?: TokenList) => Promise<void>;
  token: (onList?: TokenList) => Promise<string>;
  upload: (file: File, csrf: string) => Promise<UploadReceipt>;
};

export type ApiClient = {
  cards: (automatic?: boolean) => Promise<CardListing>;
  mailList: (automatic?: boolean) => Promise<MailListing>;
  mailThread: (ref: string, automatic?: boolean) => Promise<MailRead>;
  card: (id: string, automatic?: boolean) => Promise<CardRead>;
  answer: (id: string, input: AnswerPost, onList?: TokenList) => Promise<AnswerSent>;
  comment: (id: string, input: CommentPost, onList?: TokenList) => Promise<void>;
  freshUntil: () => number | null;
  refreshes: (onRefresh: (lists: EventLists) => void, onError?: () => void, onState?: (state: EventConnection) => void) => () => void;
  bindSession: (control: SessionControl) => void;
  signOutToken: () => Promise<string>;
  discard: () => void;
  call: (meta: SessionRequest, path: string, init: RequestInit) => Promise<Response>;
  chat?: ChatClient;
};

type Raw = Record<string, unknown>;

const LIST_PATH = "/captain/cards";
const EVENTS_PATH = "/captain/events";
const MAIL_PATH = "/captain/mail";
const MAIL_REF = /^MT-[1-9][0-9]{0,8}$/;
export const SIGN_IN_PATH = "/captain/login";
export const SIGN_OUT_PATH = "/captain/logout";
const CHATS_PATH = "/captain/api/chats";
const CHAT_PATH = "/captain/api/chat";
const CHAT_READ_PATH = CHAT_PATH + "/read";
const FILES_PATH = "/captain/api/files";
const POST_TIMEOUT = 20_000;
const UPLOAD_TIMEOUT = 180_000;
const chatOn = typeof __QD_CHAT__ !== "undefined" && __QD_CHAT__ === "on";

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const unreadable = (what: string) => new Refused("The server's answer could not be read: " + what + ".");

function idOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value)) throw unreadable("id");
  return value;
}

function text(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value === "") throw unreadable(key);
  return value;
}

function listOf(raw: unknown, key: string): unknown[] {
  const value = isRecord(raw) ? raw[key] : undefined;
  if (!Array.isArray(value)) throw unreadable(key);
  return value;
}

function answerOf(raw: unknown): ListedAnswer | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw unreadable("answer");
  return { pick: text(raw, "pick"), at: text(raw, "at") };
}

function stateOf(value: unknown): ListedCard["state"] {
  if (value !== "open" && value !== "done" && value !== "withdrawn") throw unreadable("state");
  return value;
}

function revOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw unreadable("rev");
  return value;
}

function cardOf(raw: unknown): ListedCard {
  if (!isRecord(raw)) throw unreadable("a card");
  const { due } = raw;
  if (due !== null && typeof due !== "string") throw unreadable("due");
  const card: ListedCard = { id: idOf(raw.id), title: text(raw, "title"), project: text(raw, "project"), lane: text(raw, "lane"), due, state: stateOf(raw.state), changedAt: text(raw, "changed-at") };
  if (raw.from !== undefined) card.from = text(raw, "from");
  if (raw.rev !== undefined) card.rev = revOf(raw.rev);
  if (raw.answer !== undefined) card.answer = answerOf(raw.answer);
  if (raw.waitsOn !== undefined) card.waitsOn = raw.waitsOn === null ? null : text(raw, "waitsOn");
  return card;
}

function listingOf(body: unknown): CardListing {
  if (!isRecord(body) || typeof body.truncated !== "boolean") throw unreadable("the list");
  if (listOf(body, "plainMail").length > 20) throw unreadable("too many plain mails");
  const rows: unknown[] = [];
  for (const project of listOf(body, "projects")) {
    for (const lane of listOf(project, "lanes")) {
      const cards = listOf(lane, "cards");
      if (rows.length + cards.length > 200) throw unreadable("too many cards");
      rows.push(...cards);
    }
  }
  const cards = rows.map(cardOf);
  return { cards, truncated: body.truncated };
}

function fieldsOf(raw: unknown): CardFields {
  if (!isRecord(raw)) throw unreadable("the card");
  for (const key of ["id", "project", "title"]) text(raw, key);
  for (const key of ["about", "context"]) if (typeof raw[key] !== "string") throw unreadable(key);
  for (const key of ["card", "lane", "ascii", "pick_why", "you_do", "skip", "due", "note"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw unreadable(key);
  }
  if (raw.due !== undefined && !(typeof raw.due === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.due) && Number.isFinite(Date.parse(raw.due)))) throw unreadable("due");
  if (raw.qd !== undefined && raw.qd !== "card/1") throw unreadable("qd");
  if (raw.door !== undefined && raw.door !== "one-way" && raw.door !== "two-way") throw unreadable("door");
  if (raw.kind !== undefined && !(typeof raw.kind === "string" && ["decision", "action", "fyi"].includes(raw.kind))) throw unreadable("kind");
  if (!Array.isArray(raw.category) || raw.category.length < 1 || raw.category.length > 2 || !raw.category.every((item) => ["design", "strategy", "high-risk", "try-it", "your-hands"].includes(item))) throw unreadable("category");
  if (raw.words !== undefined && !(Array.isArray(raw.words) && raw.words.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((word) => typeof word === "string")))) throw unreadable("words");
  for (const [key, fields] of [["learn", ["label", "url"]], ["commands", ["where", "run"]]] as const) {
    const values = raw[key];
    if (values !== undefined && !(Array.isArray(values) && values.every((item) => isRecord(item) && fields.every((field) => typeof item[field] === "string")))) throw unreadable(key);
  }
  if (raw.principles !== undefined && !(isRecord(raw.principles) && typeof raw.principles.follows === "string" && typeof raw.principles.departs === "string")) throw unreadable("principles");
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) throw unreadable("options");
    for (const option of raw.options) {
      if (!isRecord(option) || typeof option.label !== "string") throw unreadable("option");
      if (option.pick !== undefined && typeof option.pick !== "boolean") throw unreadable("pick");
      for (const key of ["does", "cost", "risk", "undo", "tradeoff", "why"]) if (option[key] !== undefined && typeof option[key] !== "string") throw unreadable(key);
      for (const key of ["pros", "cons"]) if (option[key] !== undefined && !(Array.isArray(option[key]) && option[key].every((item) => typeof item === "string"))) throw unreadable(key);
    }
  }
  return raw as unknown as CardFields;
}

function eventOf(raw: unknown): CardEvent {
  if (!isRecord(raw)) throw unreadable("an event");
  const { kind, document } = raw;
  const who = { sender: text(raw, "sender"), sent: text(raw, "sent") };
  if (kind === "card" || kind === "update" || kind === "comment" || kind === "withdraw") return { kind, ...who };
  if (kind !== "answer" || !isRecord(document)) throw unreadable("an event");
  const { note, comment } = document;
  if (note !== undefined && typeof note !== "string") throw unreadable("note");
  return { kind, ...who, pick: text(document, "pick"), rev: revOf(document.rev), note: note ?? null, forComment: comment !== undefined };
}

function readOf(body: unknown): CardRead {
  if (!isRecord(body)) throw unreadable("the card");
  return { card: fieldsOf(body.card), rev: revOf(body.rev), state: stateOf(body.state), thread: listOf(body, "thread").map(eventOf) };
}

function failureOf(status: number): Error {
  if (status === 401 || status === 403) return new SignInRequired();
  if (status === 404) return new NotFound();
  if (status >= 500) return new Unavailable("The server is not answering.");
  return new Refused("The server refused the request.");
}

const wantsCards = (data: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(data);
    return !(isRecord(parsed) && parsed.cards === false);
  } catch {
    return true;
  }
};

const wantsMail = (data: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(data);
    return !isRecord(parsed) || parsed.mail === true;
  } catch {
    return true;
  }
};

const wantsChats = (data: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(data);
    return !isRecord(parsed) || parsed.chats === true;
  } catch {
    return true;
  }
};

const browserFetch: Send = (path, init) => fetch(path, init);

export function createApiClient(options: { send?: Send; openEvents?: (address: string) => EventStream; schedule?: Schedule } = {}): ApiClient {
  const send = options.send ?? browserFetch;
  let held: { etag: string; listing: CardListing } | null = null;
  let heldMail: { etag: string; listing: MailListing } | null = null;
  let generation = 0;
  let csrf: string | null = null;
  let fresh: number | null = null;
  let session: SessionControl | null = null;
  const request = (meta: SessionRequest, perform: () => Promise<Response>) => session ? session.request(meta, perform) : perform();

  async function get(path: string, more: Record<string, string> = {}, automatic = false, kind: SessionRequest["kind"] = path === LIST_PATH ? "list" : path.startsWith(MAIL_PATH) ? "mail" : "card", meta: SessionRequest = { kind, automatic }): Promise<Response> {
    return request(meta, async () => {
      try {
        return await send(path, { method: "GET", headers: { Accept: "application/json", ...more }, credentials: "same-origin", redirect: "error" });
      } catch {
        throw new Unavailable("The server is not answering.");
      }
    });
  }

  async function jsonOf(response: Response, limit = 1_048_576, failure: () => Error = () => unreadable("it is not JSON")): Promise<unknown> {
    try {
      const { text, cut } = await readText(response, limit, true);
      if (cut) throw unreadable("more than 1 MiB");
      return JSON.parse(text) as unknown;
    } catch {
      throw failure();
    }
  }

  function refusal(status: number, mine: number): Error {
    const failure = failureOf(status);
    if (failure instanceof SignInRequired && mine === generation) {
      generation += 1;
      held = null;
      heldMail = null;
      csrf = null;
      fresh = null;
    }
    return failure;
  }

  function take(body: unknown, mine: number): void {
    if (mine !== generation) return;
    const token = tokenOf(body);
    if (token.csrf !== null) csrf = token.csrf;
    if (token.freshUntil !== null) fresh = token.freshUntil;
  }

  async function cards(automatic = false): Promise<CardListing> {
    const mine = generation;
    const response = await get(LIST_PATH, held && csrf !== null ? { "If-None-Match": held.etag } : {}, automatic);
    if (mine !== generation) throw new SignInRequired();
    if (response.status === 304 && held) return held.listing;
    if (response.status !== 200) throw refusal(response.status, mine);
    const body = await jsonOf(response);
    const listing = listingOf(body);
    if (mine !== generation) throw new SignInRequired();
    const etag = response.headers.get("ETag");
    held = etag ? { etag, listing } : null;
    take(body, mine);
    return listing;
  }

  async function card(id: string, automatic = false): Promise<CardRead> {
    const mine = generation;
    const response = await get(LIST_PATH + "/" + idOf(id), {}, automatic);
    if (mine !== generation) throw new SignInRequired();
    if (response.status !== 200) throw refusal(response.status, mine);
    const body = await jsonOf(response);
    const result = readOf(body);
    if (mine !== generation) throw new SignInRequired();
    take(body, mine);
    return result;
  }

  async function mailList(automatic = false): Promise<MailListing> {
    const mine = generation;
    const response = await get(MAIL_PATH, heldMail ? { "If-None-Match": heldMail.etag } : {}, automatic);
    if (mine !== generation) throw new SignInRequired();
    if (response.status === 304 && heldMail) return heldMail.listing;
    if (response.status !== 200) throw refusal(response.status, mine);
    const body = await jsonOf(response);
    const { parseMailList } = await import("./mail-client");
    const listing = parseMailList(body);
    if (mine !== generation) throw new SignInRequired();
    const etag = response.headers.get("ETag");
    heldMail = etag ? { etag, listing } : null;
    return listing;
  }

  async function mailThread(ref: string, automatic = false): Promise<MailRead> {
    if (!MAIL_REF.test(ref)) throw unreadable("ref");
    const mine = generation;
    const response = await get(MAIL_PATH + "/" + ref, {}, automatic);
    if (mine !== generation) throw new SignInRequired();
    if (response.status !== 200) throw refusal(response.status, mine);
    const body = await jsonOf(response);
    const { parseMailThread } = await import("./mail-client");
    const result = parseMailThread(body);
    if (mine !== generation) throw new SignInRequired();
    if (result.summary.ref !== ref) throw unreadable("a thread ref");
    return result;
  }

  function rejection(status: number, mine: number): Error {
    if (status === 429) return new RateLimited();
    if (status >= 500 || status < 400) return new NotConfirmed();
    return refusal(status, mine);
  }

  async function tokenRead(wait = false): Promise<{ csrf: string; listing: CardListing; sent: number | undefined }> {
    const began = generation;
    csrf = null;
    const meta: SessionRequest = wait ? { kind: "token", automatic: false, wait } : { kind: "token", automatic: false };
    const response = await get(LIST_PATH, {}, false, "token", meta);
    if (began !== generation) throw new SignInRequired();
    if (response.status !== 200) throw refusal(response.status, began);
    const body = await jsonOf(response);
    const listing = listingOf(body);
    const given = tokenOf(body).csrf;
    if (began !== generation) throw new SignInRequired();
    if (given === null) throw new Refused("Not sent: the server gave no sign-in token.");
    const etag = response.headers.get("ETag");
    held = etag ? { etag, listing } : null;
    return { csrf: given, listing, sent: meta.sent };
  }

  const signOutToken = async (): Promise<string> => (await tokenRead()).csrf;

  type Submit = { limit?: number; refuse?: (response: Response, mine: number) => Promise<Error>; cut?: () => Error; chain?: ChatChain };

  async function submit<T extends CommentReceipt>(path: string, check: () => void, bodyOf: (token: string) => string, receiptOf: (raw: unknown) => T, onList?: TokenList, more: Submit = {}): Promise<T> {
    check();
    const wait = more.chain !== undefined;
    let token = more.chain?.csrf ?? null;
    if (token === null) {
      const read = await tokenRead(wait);
      onList?.(read.listing, read.sent);
      token = read.csrf;
    }
    const body = bodyOf(token);
    const mine = generation;
    const controller = new AbortController();
    let stop = (): void => undefined;
    try {
      const response = await request(wait ? { kind: "post", automatic: false, wait } : { kind: "post", automatic: false }, async () => {
        stop = (options.schedule ?? later)(() => controller.abort(), POST_TIMEOUT);
        csrf = null;
        try {
          return await send(path, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body, credentials: "same-origin", redirect: "manual", signal: controller.signal });
        } catch {
          throw controller.signal.aborted && more.cut ? more.cut() : new NotConfirmed();
        }
      });
      if (response.type === "opaqueredirect" || response.status === 303) throw new FreshSignInRequired();
      if (response.status !== 200) throw await (more.refuse ? more.refuse(response, mine) : rejection(response.status, mine));
      const receipt = receiptOf(await jsonOf(response, more.limit ?? 4096, () => new NotConfirmed()));
      if (mine === generation) {
        if (receipt.csrf !== "") csrf = receipt.csrf;
        fresh = receipt.freshUntil;
      }
      return receipt;
    } finally {
      stop();
    }
  }

  let chatClient: ChatClient | undefined;
  if (typeof __QD_CHAT__ !== "undefined" && __QD_CHAT__ === "on") {
    async function rows(automatic: boolean): Promise<ChatList> {
      const lib = await import("./chat-client");
      const mine = generation;
      const response = await get(CHATS_PATH, {}, automatic, "chat");
      if (mine !== generation) throw new SignInRequired();
      if (response.status !== 200) throw refusal(response.status, mine);
      const listed = lib.parseChatList(await jsonOf(response));
      if (mine !== generation) throw new SignInRequired();
      return listed;
    }

    async function thread(bot: string, before: string | undefined, automatic: boolean, after?: string): Promise<ChatRead> {
      const lib = await import("./chat-client");
      const path = after === undefined ? lib.threadPath(bot, before) : lib.newerPath(bot, after);
      const mine = generation;
      const response = await get(path, {}, automatic, "chat");
      if (mine !== generation) throw new SignInRequired();
      if (after !== undefined && response.status === 409 && (await errorIs(response, "cursor"))) throw new lib.CursorGone();
      if (response.status !== 200) throw refusal(response.status, mine);
      const read = lib.parseChatThread(await jsonOf(response));
      if (mine !== generation) throw new SignInRequired();
      if (read.bot.id !== bot) throw unreadable("a thread bot");
      return read;
    }

    async function errorOf(response: Response): Promise<string | null> {
      const body = await jsonOf(response, 256).catch(() => null);
      return isRecord(body) && Object.keys(body).join() === "error" && typeof body.error === "string" ? body.error : null;
    }

    const errorIs = async (response: Response, name: string): Promise<boolean> => (await errorOf(response)) === name;

    async function refuse(response: Response, mine: number): Promise<Error> {
      const { CHAT_WORDS } = await import("./chat-client");
      const status = response.status;
      if (status === 429) return new RateLimited();
      if (status === 401 || status === 403) return refusal(status, mine);
      if (status === 422) {
        const error = await errorOf(response);
        return new Refused(error === "quote" ? CHAT_WORDS.quoteGone : error === "files" ? CHAT_WORDS.expired : CHAT_WORDS.bot);
      }
      if (status === 400) return new Refused(CHAT_WORDS.text);
      if (status === 502 || (status < 500 && status >= 400)) return new Refused(CHAT_WORDS.mail);
      return new NotConfirmed();
    }

    async function sendChat(bot: string, outgoing: WireOutgoing, onList?: TokenList, chain?: ChatChain): Promise<ChatReceipt> {
      const lib = await import("./chat-client");
      return submit(CHAT_PATH, () => lib.checkOutgoing(bot, outgoing), (token) => lib.chatBody(bot, outgoing, token), (raw) => lib.chatReceiptOf(raw, outgoing.clientId), onList, { limit: 16384, refuse, chain });
    }

    async function chainToken(onList?: TokenList): Promise<string> {
      const read = await tokenRead(true);
      onList?.(read.listing, read.sent);
      return read.csrf;
    }

    async function upload(file: File, token: string): Promise<UploadReceipt> {
      const lib = await import("./chat-client");
      const type = lib.uploadType(file);
      const mine = generation;
      const controller = new AbortController();
      let stop = (): void => undefined;
      try {
        const response = await request({ kind: "post", automatic: false, wait: true }, async () => {
          stop = (options.schedule ?? later)(() => controller.abort(), UPLOAD_TIMEOUT);
          csrf = null;
          try {
            return await send(FILES_PATH, { method: "POST", headers: { Accept: "application/json", "Content-Type": type, "X-QD-File-Name": encodeURIComponent(file.name), "X-QD-Csrf": token }, body: file, credentials: "same-origin", redirect: "manual", signal: controller.signal });
          } catch {
            throw new NotConfirmed();
          }
        });
        if (response.type === "opaqueredirect" || response.status === 303) throw new FreshSignInRequired();
        if (response.status === 429) throw new RateLimited();
        if (response.status === 401 || response.status === 403) throw refusal(response.status, mine);
        if (response.status === 413) throw new Refused(lib.bigText(file.name));
        if (response.status === 422) throw new Refused(lib.typeText(file.name));
        if (response.status !== 200) throw new NotConfirmed();
        const receipt = lib.uploadReceiptOf(await jsonOf(response, 4096, () => new NotConfirmed()));
        if (mine === generation) {
          csrf = receipt.csrf;
          fresh = receipt.freshUntil;
        }
        return receipt;
      } finally {
        stop();
      }
    }

    async function readChat(bot: string, upTo: string, onList?: TokenList): Promise<void> {
      const lib = await import("./chat-client");
      await submit(CHAT_READ_PATH, () => lib.checkRead(bot, upTo), (token) => lib.readBody(bot, upTo, token), lib.readReceiptOf, onList);
    }

    chatClient = { rows, thread, newer: (bot, after, automatic) => thread(bot, undefined, automatic, after), send: sendChat, read: readChat, token: chainToken, upload };
  }

  async function answer(id: string, input: AnswerPost, onList?: TokenList): Promise<AnswerSent> {
    const { message, stale, rev } = await submit(LIST_PATH + "/" + idOf(id) + "/answer", () => checkAnswer(input), (token) => answerBody(input, token), answerReceiptOf, onList, { cut: () => new TimedOut() });
    return { message, stale, rev };
  }

  async function comment(id: string, input: CommentPost, onList?: TokenList): Promise<void> {
    await submit(LIST_PATH + "/" + idOf(id) + "/comments", () => checkComment(input), (token) => commentBody(input, token), commentReceiptOf, onList);
  }

  const listeners = new Set<{ onRefresh: (lists: EventLists) => void; onError?: () => void; onState?: (state: EventConnection) => void }>();
  let closeStream: (() => void) | null = null;

  const refreshes = (onRefresh: (lists: EventLists) => void, onError?: () => void, onState?: (state: EventConnection) => void) => {
    const listener = { onRefresh, onError, onState };
    listeners.add(listener);
    closeStream ??= watchEvents(
      EVENTS_PATH,
      "refresh",
      (data) => {
        const lists: EventLists = { cards: wantsCards(data), mail: wantsMail(data), ...(chatOn ? { chats: wantsChats(data) } : {}) };
        if (lists.cards || lists.mail || lists.chats) for (const each of [...listeners]) each.onRefresh(lists);
      },
      options.openEvents,
      () => { for (const each of [...listeners]) each.onError?.(); },
      (state) => {
        if (state === "closed") {
          closeStream?.();
          closeStream = null;
        }
        for (const each of [...listeners]) each.onState?.(state);
      },
    );
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && closeStream) {
        closeStream();
        closeStream = null;
      }
    };
  };

  return { cards, card, mailList, mailThread, answer, comment, freshUntil: () => fresh, refreshes, bindSession: (control) => { session = control; }, signOutToken, discard: () => { held = null; heldMail = null; csrf = null; fresh = null; }, call: (meta, path, init) => request(meta, () => send(path, init)), ...(chatOn ? { chat: chatClient! } : {}) };
}
