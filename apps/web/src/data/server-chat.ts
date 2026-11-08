import { wireQuote, type WireQuote } from "../domain/chat";
import type { Bot } from "../domain/types";
import type { Schedule } from "../platform/timer";
import { Unavailable, type ChatClient, type TokenList } from "./api-client";
import { appendSent, botsOf, CHAT_WORDS, CursorGone, keepSent, mergeAfter, mergeNewest, mergeOlder, rowsOf, threadOf, threadStale, type ChatListed, type ChatRead, type ChatReceipt } from "./chat-client";
import type { ChatMessage, ChatRow, ChatThread, Outgoing, Quote, SentChatMessage, SentQuote, ServerChatApi, ServerUploadVerdict } from "./chat-types";
import { NotConfirmed, Refused, SignInRequired } from "./source";

export type ChatHost = {
  chat: ChatClient;
  clock: () => number;
  schedule: Schedule;
  access: () => void;
  read: <T>(request: () => Promise<T>) => Promise<T>;
  live: () => boolean;
  arm: () => void;
  republish: () => void;
  token: () => TokenList;
  generation: () => number;
  epoch: () => number;
};

export type ChatDue = { kind: "list" } | { kind: "thread"; bot: string } | { kind: "read"; bot: string; upTo: string };

export type ChatPart = {
  api: ServerChatApi;
  bots: () => Bot[];
  due: () => ChatDue | null;
  run: (due: ChatDue) => Promise<void>;
  running: () => boolean;
  event: () => void;
  back: () => void;
  clear: () => void;
};

const OPEN_SPACING = 5_000;
const SEND_CAP = 55_000;
const ATTEMPT_CAP = 25_000;
const REREAD_CAP = 5_000;
const RETRY_AFTER = 5_000;

const passing = (error: unknown): boolean => error instanceof NotConfirmed || error instanceof Unavailable || (error instanceof Refused && error.message === CHAT_WORDS.mail);

function cursorGone(error: unknown): null {
  if (error instanceof CursorGone) return null;
  throw error;
}

function plain(receipt: ChatReceipt, quote?: SentQuote): ChatMessage {
  const message: ChatMessage = { id: receipt.id, from: receipt.from, text: receipt.text, at: receipt.at, refs: receipt.refs };
  if (receipt.clientId !== undefined) message.clientId = receipt.clientId;
  const shown = receipt.quote ?? quote;
  if (shown !== undefined) message.quote = shown;
  return message;
}

const sentOf = (message: ChatMessage): SentChatMessage<ServerUploadVerdict> => ({ ...message, uploadVerdicts: [] });

function shownQuote(wire: WireQuote, held: ChatRead | undefined): SentQuote | undefined {
  if ("cardId" in wire) return wire;
  const quoted = held?.messages.find((one) => one.id === wire.id);
  return quoted ? { id: wire.id, from: quoted.from, at: quoted.at, text: wire.text } : undefined;
}

export function createServerChat(host: ChatHost): ChatPart {
  let listed: ChatListed[] | null = null;
  let listedAt = -Infinity;
  const threads = new Map<string, ChatRead>();
  const tried = new Map<string, string>();
  const rowWatchers = new Set<() => void>();
  const threadWatchers = new Map<string, Set<(thread: ChatThread) => void>>();
  const flights = new Map<string, Promise<void>>();
  const olderFlights = new Map<string, Promise<void>>();
  let listFlight: Promise<void> | null = null;
  let wanted = false;
  let staleAt: number | null = null;
  let busy = false;
  const marked = new Map<string, string>();
  const poked = new Set<string>();
  let reading: Promise<void> | null = null;
  let sending = 0;
  const unshown = new Map<string, Map<string, ChatMessage>>();
  const readsStarted = new Map<string, number>();
  const readsApplied = new Map<string, number>();

  function within<T>(work: Promise<T>, limit: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const stop = host.schedule(() => reject(new NotConfirmed()), Math.max(0, limit));
      work.then(
        (value) => {
          stop();
          resolve(value);
        },
        (error: unknown) => {
          stop();
          reject(error);
        },
      );
    });
  }

  const pause = (delay: number): Promise<void> =>
    new Promise((done) => {
      host.schedule(done, delay);
    });

  function remember(bot: string, message: ChatMessage): void {
    if (message.clientId === undefined) return;
    let mine = unshown.get(bot);
    if (!mine) {
      mine = new Map();
      unshown.set(bot, mine);
    }
    mine.set(message.clientId, message);
  }

  function stillUnshown(bot: string, page: ChatRead): ChatMessage[] {
    const mine = unshown.get(bot);
    if (!mine) return [];
    for (const [clientId, one] of mine) if (page.messages.some((held) => held.id === one.id || held.clientId === clientId)) mine.delete(clientId);
    return [...mine.values()];
  }

  const onScreen = (): boolean => rowWatchers.size > 0 || [...threadWatchers.values()].some((set) => set.size > 0);

  const orderOf = (bot: string): number => Math.max(0, listed?.findIndex((one) => one.bot.id === bot) ?? 0);

  const watchersOf = (bot: string): Set<(thread: ChatThread) => void> => {
    let set = threadWatchers.get(bot);
    if (!set) {
      set = new Set();
      threadWatchers.set(bot, set);
    }
    return set;
  };

  function tellThread(bot: string): void {
    const held = threads.get(bot);
    const set = threadWatchers.get(bot);
    if (!held || !set) return;
    const thread = threadOf(held, orderOf(bot));
    for (const heard of [...set]) heard(thread);
  }

  async function readList(automatic: boolean): Promise<void> {
    host.access();
    const started = host.clock();
    wanted = false;
    const value = await host.read(() => host.chat.rows(automatic));
    const before = JSON.stringify(listed);
    const botsBefore = JSON.stringify(listed === null ? null : botsOf(listed));
    listed = value;
    listedAt = started;
    if (staleAt !== null && staleAt <= started) staleAt = null;
    if (JSON.stringify(botsOf(value)) !== botsBefore) host.republish();
    if (JSON.stringify(value) !== before) for (const heard of [...rowWatchers]) heard();
  }

  function openList(): Promise<void> {
    if (listFlight) return listFlight;
    const flight: Promise<void> = readList(false).finally(() => {
      if (listFlight === flight) listFlight = null;
    });
    listFlight = flight;
    return flight;
  }

  async function listChats(): Promise<ChatRow[]> {
    host.access();
    if (listed === null || staleAt !== null || host.clock() >= listedAt + OPEN_SPACING) await openList();
    return rowsOf(listed ?? []);
  }

  function cursorOf(bot: string): string | null {
    const held = threads.get(bot);
    if (!held?.features.includes("cursor")) return null;
    const mine = unshown.get(bot);
    for (let at = held.messages.length - 1; at >= 0; at -= 1) {
      const one = held.messages[at];
      if (one.clientId === undefined || !mine?.has(one.clientId)) return one.id;
    }
    return null;
  }

  async function readThread(bot: string, automatic: boolean): Promise<void> {
    host.access();
    const mine = (readsStarted.get(bot) ?? 0) + 1;
    readsStarted.set(bot, mine);
    const after = automatic ? cursorOf(bot) : null;
    const newer = after === null ? null : await host.read(() => host.chat.newer(bot, after, automatic)).catch(cursorGone);
    const page = newer ?? (await host.read(() => host.chat.thread(bot, undefined, automatic)));
    if ((readsApplied.get(bot) ?? 0) > mine) return;
    readsApplied.set(bot, mine);
    const held = threads.get(bot) ?? null;
    threads.set(bot, keepSent(held && newer && after !== null ? mergeAfter(held, after, newer) : mergeNewest(held, page), stillUnshown(bot, page)));
    tellThread(bot);
    host.arm();
  }

  async function openThread(bot: string): Promise<ChatThread> {
    host.access();
    let flight = flights.get(bot);
    if (!flight) {
      const made: Promise<void> = readThread(bot, false).finally(() => {
        if (flights.get(bot) === made) flights.delete(bot);
      });
      flights.set(bot, made);
      flight = made;
    }
    await flight;
    const held = threads.get(bot);
    if (!held) throw new Refused("The thread could not be read.");
    return threadOf(held, orderOf(bot));
  }

  async function older(bot: string): Promise<ChatThread> {
    host.access();
    const held = threads.get(bot);
    if (!held) throw new Refused("This thread is not open.");
    const oldest = held.messages[0]?.id;
    if (held.older && oldest !== undefined) {
      let flight = olderFlights.get(bot);
      if (!flight) {
        const made: Promise<void> = (async () => {
          const page = await host.read(() => host.chat.thread(bot, oldest, false));
          const now = threads.get(bot);
          if (now) threads.set(bot, mergeOlder(now, page));
          tellThread(bot);
        })().finally(() => {
          if (olderFlights.get(bot) === made) olderFlights.delete(bot);
        });
        olderFlights.set(bot, made);
        flight = made;
      }
      await flight;
    }
    const now = threads.get(bot);
    if (!now) throw new Refused("This thread is not open.");
    return threadOf(now, orderOf(bot));
  }

  async function foundSent(bot: string, clientId: string, limit: number): Promise<ChatMessage | null> {
    try {
      await within(readThread(bot, false), Math.min(REREAD_CAP, limit));
    } catch (error) {
      if (error instanceof SignInRequired) throw error;
      return null;
    }
    return threads.get(bot)?.messages.find((one) => one.clientId === clientId && one.from === "captain") ?? null;
  }

  async function send(bot: string, outgoing: Outgoing): Promise<SentChatMessage<ServerUploadVerdict>> {
    host.access();
    if (reading) await reading;
    sending += 1;
    try {
      return await deliver(bot, outgoing);
    } finally {
      sending -= 1;
    }
  }

  function wired(bot: string, quote: Quote): WireQuote {
    const held = threads.get(bot);
    if (!held?.features.includes("quote")) throw new Refused(CHAT_WORDS.quote);
    const stored = "cardId" in quote ? null : (held.messages.find((one) => one.id === quote.messageId)?.text ?? null);
    const wire = wireQuote(quote, stored);
    if (!wire) throw new Refused(CHAT_WORDS.quoteGone);
    return wire;
  }

  async function deliver(bot: string, outgoing: Outgoing): Promise<SentChatMessage<ServerUploadVerdict>> {
    host.access();
    const { quote, ...rest } = outgoing;
    const wire = quote === undefined ? undefined : wired(bot, quote);
    const mine = host.generation();
    const epoch = host.epoch();
    const ends = host.clock() + SEND_CAP;
    const left = (): number => ends - host.clock();
    const current = (): void => {
      if (mine !== host.generation()) throw new SignInRequired();
    };
    for (let tries = 1; ; tries += 1) {
      let receipt: ChatReceipt;
      try {
        receipt = await within(host.chat.send(bot, wire === undefined ? rest : { ...rest, quote: wire }, host.token()), Math.min(ATTEMPT_CAP, left()));
      } catch (error) {
        current();
        if (!passing(error)) throw error;
        const found = error instanceof NotConfirmed && left() > 0 ? await foundSent(bot, outgoing.clientId, left()) : null;
        current();
        if (found) return sentOf(found);
        if (tries === 2 || left() <= RETRY_AFTER) throw error;
        await pause(RETRY_AFTER);
        current();
        const later = await foundSent(bot, outgoing.clientId, left());
        current();
        if (later) return sentOf(later);
        if (left() <= 0) throw error;
        continue;
      }
      current();
      const sent = plain(receipt, wire && shownQuote(wire, threads.get(bot)));
      if (epoch === host.epoch()) {
        remember(bot, sent);
        const held = threads.get(bot);
        if (held) {
          threads.set(bot, appendSent(held, sent));
          tellThread(bot);
        }
      }
      return sentOf(sent);
    }
  }

  const stamp = (row: ChatListed): string => row.last + "\u0000" + (row.rev ?? "");

  function newestBot(held: ChatRead): string | null {
    let newest: string | null = null;
    for (const one of held.messages) if (one.from === "bot") newest = one.id;
    return newest;
  }

  function unmarked(bot: string): string | null {
    const held = threads.get(bot);
    if (!held || held.firstUnread === null || !held.features.includes("read")) return null;
    const upTo = newestBot(held);
    return upTo === null || marked.get(bot) === upTo ? null : upTo;
  }

  async function markRead(bot: string, upTo: string): Promise<void> {
    const mine = host.generation();
    marked.set(bot, upTo);
    try {
      await host.chat.read(bot, upTo, host.token());
    } catch {
      return;
    }
    const held = threads.get(bot);
    if (mine !== host.generation() || !held || newestBot(held) !== upTo) return;
    threads.set(bot, { ...held, firstUnread: null });
    if (listed === null || !listed.some((one) => one.bot.id === bot && one.unread)) return;
    listed = listed.map((one) => (one.bot.id === bot ? { ...one, unread: false } : one));
    for (const heard of [...rowWatchers]) heard();
  }

  function due(): ChatDue | null {
    if (busy || !host.live()) return null;
    const [poke] = poked;
    if (poke !== undefined) return { kind: "thread", bot: poke };
    if (wanted && onScreen()) return { kind: "list" };
    if (listed !== null) {
      for (const [bot, set] of threadWatchers) {
        const held = threads.get(bot);
        const row = listed.find((one) => one.bot.id === bot);
        if (set.size > 0 && held && row && threadStale(row, held) && tried.get(bot) !== stamp(row)) return { kind: "thread", bot };
      }
    }
    if (sending > 0) return null;
    for (const [bot, set] of threadWatchers) {
      const upTo = set.size > 0 ? unmarked(bot) : null;
      if (upTo !== null) return { kind: "read", bot, upTo };
    }
    return null;
  }

  async function run(job: ChatDue): Promise<void> {
    busy = true;
    try {
      if (job.kind === "list") await readList(true);
      else if (job.kind === "read") {
        const flight = markRead(job.bot, job.upTo);
        reading = flight;
        try {
          await flight;
        } finally {
          if (reading === flight) reading = null;
        }
      } else {
        poked.delete(job.bot);
        const row = listed?.find((one) => one.bot.id === job.bot);
        if (row) tried.set(job.bot, stamp(row));
        await readThread(job.bot, true);
      }
    } catch {
      return;
    } finally {
      busy = false;
      host.arm();
    }
  }

  function event(): void {
    if (onScreen()) {
      wanted = true;
      for (const [bot, set] of threadWatchers) if (set.size > 0 && threads.get(bot)?.features.includes("cursor")) poked.add(bot);
    } else staleAt = host.clock();
    host.arm();
  }

  function back(): void {
    if (onScreen()) wanted = true;
  }

  function clear(): void {
    listed = null;
    listedAt = -Infinity;
    threads.clear();
    tried.clear();
    marked.clear();
    unshown.clear();
    flights.clear();
    olderFlights.clear();
    listFlight = null;
    wanted = false;
    poked.clear();
    staleAt = null;
  }

  const api: ServerChatApi = {
    uploadBoundary: "server",
    listChats,
    watchChats(onChange) {
      rowWatchers.add(onChange);
      return () => {
        rowWatchers.delete(onChange);
        host.arm();
      };
    },
    openThread,
    subscribe(bot, onChange) {
      watchersOf(bot).add(onChange);
      host.arm();
      return () => {
        const set = threadWatchers.get(bot);
        set?.delete(onChange);
        if (set?.size === 0) {
          marked.delete(bot);
          poked.delete(bot);
        }
        host.arm();
      };
    },
    older,
    send,
  };

  return { api, bots: () => (listed === null ? [] : botsOf(listed)), due, run, running: () => busy, event, back, clear };
}
