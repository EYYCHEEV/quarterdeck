import type { Answer, Bot, Card, Choice, Lane, MailThread, Project, World } from "../domain/types";
import { goTo, postForm, type Pages } from "../platform/navigate";
import { readJson, writeJson } from "../platform/storage";
import { schedule as later, type Schedule } from "../platform/timer";
import { pageVisibility, type Visibility } from "../platform/visibility";
import { NotFound, SIGN_IN_PATH, SIGN_OUT_PATH, type AnswerSent, type ApiClient, type CardEvent, type CardListing, type CardRead, type ListedCard, type TokenList } from "./api-client";
import type * as MailModule from "./mail-client";
import type { MailListed, MailRead } from "./mail-client";
import type { ChatApi, ServerChatApi } from "./chat-types";
import type { ChatHost, ChatPart } from "./server-chat";
import type { BotsPart } from "./server-bots";
import { forgetLocal, forgetSession } from "./forget-local";
import type { CaptainSecretsApi } from "./secret-types";
import { detailOf } from "./server-card";
import { LapsedWhileHidden, NotConfirmed, RateLimited, Refused, SessionUnconfirmed, SignInRequired, type AnswerInput, type CommentInput, type QdData } from "./source";

const SEEN_KEY = "qd.seen";

type MailLib = typeof MailModule;

const NOT_BUILT = "This is not built on the server yet.";

const notBuilt = (): Promise<never> => Promise.reject(new Refused(NOT_BUILT));

const idle = () => () => undefined;

const chatOn = typeof __QD_CHAT__ !== "undefined" && __QD_CHAT__ === "on";

const stubChat: ChatApi = {
  uploadBoundary: "server",
  listChats: () => Promise.resolve([]),
  watchChats: idle,
  openThread: notBuilt,
  subscribe: idle,
  older: notBuilt,
  send: notBuilt,
};

const secrets: CaptainSecretsApi = {
  rows: () => [],
  requests: () => [],
  events: () => [],
  subscribe: idle,
  save: notBuilt,
  decline: () => undefined,
  replace: notBuilt,
  remove: notBuilt,
  status: () => "ready",
};

const laneKey = (project: string, lane: string) => project + "/" + lane;

function storedMarks(): Map<string, string> {
  const stored = readJson(SEEN_KEY);
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return new Map();
  return new Map(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function choiceOf(pick: string): Choice | null {
  if (pick === "none") return { kind: "none" };
  if (pick === "cant-decide") return { kind: "cant-decide" };
  return /^[A-Z]$/.test(pick) ? { kind: "option", letter: pick } : null;
}

function answerOf(item: ListedCard): Answer | null {
  const choice = item.state === "done" && item.answer ? choiceOf(item.answer.pick) : null;
  if (!choice || !item.answer) return null;
  return { choice, at: item.answer.at, note: "", version: item.rev ?? 1, waitingOn: item.waitsOn ?? null, outcome: null };
}

function pickOf(choice: Choice): string {
  if (choice.kind === "option") return choice.letter;
  if (choice.kind === "none" || choice.kind === "cant-decide") return choice.kind;
  throw new Refused("Not sent: the server takes an option, none of these or can't decide.");
}

const shown = (item: ListedCard) => item.state === "open" || (item.state === "done" && Boolean(item.answer));

function cardOf(item: ListedCard, seenAt: string | null): Card {
  return {
    id: item.id,
    version: item.rev ?? 1,
    title: item.title,
    priority: "",
    owner: item.from ?? "",
    projectId: item.project,
    laneId: laneKey(item.project, item.lane),
    addedAt: item.changedAt,
    due: item.due,
    about: null,
    description: null,
    ascii: null,
    skip: null,
    options: [],
    pickWhy: null,
    approvalDoor: "two-way",
    unblocks: [],
    labels: [],
    evidence: [],
    media: [],
    commands: [],
    changes: [],
    versions: [],
    seenAt,
    answer: answerOf(item),
    more: { context: [], words: [], learn: [], note: null },
  };
}

function placesOf(items: ListedCard[]): { projects: Project[]; lanes: Lane[] } {
  const projects = new Map<string, Project>();
  const lanes = new Map<string, Lane>();
  for (const item of items) {
    const project = projects.get(item.project);
    if (!project) projects.set(item.project, { id: item.project, name: item.project, lead: "", description: "", activeAt: item.changedAt });
    else if (Date.parse(item.changedAt) > Date.parse(project.activeAt)) project.activeAt = item.changedAt;
    const id = laneKey(item.project, item.lane);
    if (!lanes.has(id)) lanes.set(id, { id, projectId: item.project, name: item.lane, status: "Active", lead: "", now: "", activity: [], lastLooked: null });
  }
  return { projects: [...projects.values()], lanes: [...lanes.values()] };
}

function worldOf(items: ListedCard[], seen: Map<string, string>, reads: Map<string, CardRead>, answered: Map<string, { given: Answer }>, mailFor: (places: { projects: Project[]; lanes: Lane[] }) => MailThread[], bots: Bot[]): World {
  const { projects, lanes } = placesOf(items);
  const cards = items.map((item) => {
    const base = cardOf(item, seen.get(item.id) ?? null);
    const read = reads.get(item.id);
    const card = read && (item.rev === undefined || item.rev <= read.rev) ? detailOf(read, base) : base;
    const mark = answered.get(item.id);
    return mark ? { ...card, answer: mark.given } : card;
  });
  return { cards, tasks: [], projects, lanes, pages: [], artifacts: [], mail: mailFor({ projects, lanes }), bots };
}

export function createServerSource(client: ApiClient, clock: () => number = Date.now, schedule: Schedule = later, pages: Pages = { goTo, postForm }, visibility: Visibility = pageVisibility): QdData {
  const seen = storedMarks();
  const reads = new Map<string, CardRead>();
  const answered = new Map<string, { given: Answer; rev: number }>();
  const tried = new Map<string, number>();
  const listeners = new Set<(failure?: Error) => void>();
  const credits: { at: number; cost: number }[] = [];
  const backoff = [5_000, 10_000, 20_000, 40_000, 45_000];
  type ListJob = {
    automatic: boolean; probe: boolean; generation: number; sent: number; status: number;
    promise: Promise<World>; resolve: (world: World) => void; reject: (error: unknown) => void;
  };
  let listed = new Map<string, ListedCard>();
  let generation = 0;
  let privateEpoch = 0;
  let paused = false;
  let unconfirmed = false;
  let confirmedAt: number | null = null;
  let lastListAt = -Infinity;
  let nextCheck: number | null = null;
  let probeAt: number | null = null;
  let retry = 0;
  let streamOpen = false;
  let wantStream = false;
  let stopEvents: (() => void) | null = null;
  let cancelCheck: (() => void) | null = null;
  let pending: ListJob | null = null;
  let current: ListJob | null = null;
  let delivery: Promise<World> | null = null;
  let automaticLoad = false;
  let mailList: MailListed[] | null = null;
  const mailReads = new Map<string, MailRead>();
  const mailTried = new Map<string, string>();
  const mailFlights = new Map<string, Promise<void>>();
  const mailThreadsOpen = new Set<string>();
  let mailListFlight: Promise<void> | null = null;
  let mailListOpen = false;
  let mailLib: MailLib | null = null;
  let lastMailAt = -Infinity;
  let mailWanted = false;
  let mailFirst = false;
  let mailFirstDone = false;
  let mailRunning = false;
  let worldReady = false;
  let chatPart: ChatPart | null = null;
  let chatLoad: Promise<ChatPart> | null = null;
  let lastChatAt = -Infinity;
  let botsPart: BotsPart | null = null;
  let away = visibility.hidden();
  let streamAway = false;
  let posting = 0;
  let postedAt = -Infinity;
  let staleAt: number | null = null;
  let appliedAt = -Infinity;
  let arrival = false;
  let onScreen: string | null = null;

  function budgetAt(cost: number, automatic: boolean): number {
    const now = clock();
    while (credits.length && credits[0].at <= now - 60_000) credits.shift();
    let spent = credits.reduce((total, item) => total + item.cost, 0);
    const limit = automatic ? 21 : 29;
    if (spent + cost <= limit) return now;
    for (const item of credits) {
      spent -= item.cost;
      if (spent + cost <= limit) return item.at + 60_000;
    }
    return now + 60_000;
  }

  const spaced = (): number => (chatOn ? Math.max(lastListAt, lastMailAt, lastChatAt) : Math.max(lastListAt, lastMailAt)) + 5_000;

  function closeEvents(): void {
    stopEvents?.();
    stopEvents = null;
    streamOpen = false;
  }

  function clearPrivate(): void {
    privateEpoch += 1;
    listed.clear();
    reads.clear();
    answered.clear();
    staleAt = null;
    postedAt = -Infinity;
    appliedAt = -Infinity;
    onScreen = null;
    tried.clear();
    mailList = null;
    mailReads.clear();
    mailTried.clear();
    mailFlights.clear();
    mailListFlight = null;
    mailWanted = false;
    mailFirst = false;
    mailFirstDone = false;
    if (chatOn) chatPart?.clear();
    botsPart?.clear();
    worldReady = false;
    client.discard();
  }

  function notify(failure?: Error): void {
    for (const listener of [...listeners]) listener(failure);
  }

  function publish(world: World): void {
    delivery = Promise.resolve(world);
    try { notify(); }
    finally { delivery = null; }
  }

  function hide(): void {
    unconfirmed = true;
    clearPrivate();
    closeEvents();
    wantStream = false;
    notify(away ? new LapsedWhileHidden() : new SessionUnconfirmed());
  }

  function expire(): void {
    if (!paused && !unconfirmed && confirmedAt !== null && clock() >= confirmedAt + 61_000) hide();
  }

  function access(): void {
    expire();
    if (paused) throw new SignInRequired();
    if (unconfirmed) throw new SessionUnconfirmed();
  }

  function sessionEnded(): void {
    if (paused) return;
    generation += 1;
    paused = true;
    unconfirmed = false;
    confirmedAt = null;
    probeAt = clock() + 61_000;
    nextCheck = null;
    wantStream = false;
    clearPrivate();
    forgetSession();
    closeEvents();
    const error = new SignInRequired();
    pending?.reject(error);
    current?.reject(error);
    pending = null;
    current = null;
    notify(error);
    arm();
  }

  function afterCheck(failed = false): void {
    nextCheck = clock() + (streamOpen || (!failed && retry === 0) ? 45_000 : backoff[Math.min(retry++, backoff.length - 1)]);
  }

  function startEvents(): void {
    if (!wantStream || away || paused || unconfirmed || stopEvents || listeners.size === 0 || budgetAt(1, true) > clock()) return;
    credits.push({ at: clock(), cost: 1 });
    wantStream = false;
    streamAway = false;
    try {
      stopEvents = client.refreshes(
        (lists) => {
          if (lists.cards) {
            if (posting > 0 || clock() < postedAt + 10_000) {
              staleAt = clock();
              arm();
            } else void demand(true).catch(() => undefined);
          }
          if (lists.mail && mailOnScreen()) {
            mailWanted = true;
            arm();
          }
          if (chatOn && lists.chats) chatPart?.event();
        },
        undefined,
        (state) => {
          if (state === "open") {
            streamOpen = true;
            retry = 0;
            nextCheck = clock() + 45_000;
          } else {
            const wasOpen = streamOpen;
            closeEvents();
            if (wasOpen || retry === 0) {
              retry = 1;
              nextCheck = Math.min(nextCheck ?? Infinity, clock() + backoff[0]);
            }
          }
          arm();
        },
      );
    } catch {
      closeEvents();
    }
  }

  function arm(): void {
    cancelCheck?.();
    cancelCheck = null;
    const times: number[] = [];
    if (paused) {
      if (probeAt !== null && !away) times.push(probeAt);
    } else {
      const spacedAt = Math.max(spaced(), budgetAt(1, true));
      if (listeners.size > 0 && !unconfirmed && confirmedAt !== null) times.push(confirmedAt + 61_000);
      if (!current && pending && !(away && pending.automatic)) times.push(pending.automatic ? spacedAt : clock());
      if (!current && !pending && !away && listeners.size > 0) {
        if (nextCheck !== null) times.push(Math.max(nextCheck, spacedAt));
        if (wantStream && !stopEvents) times.push(budgetAt(1, true));
        if (staleAt !== null && posting === 0) times.push(Math.max(postedAt + 10_000, spacedAt));
        if (!mailRunning && mailDue()) times.push(spacedAt);
        if (chatOn) {
          const chatJob = chatPart && !chatPart.running() ? chatPart.due() : null;
          if (chatJob) times.push(chatJob.kind === "list" ? spacedAt : budgetAt(chatJob.kind === "read" ? 3 : 1, true));
        }
      }
    }
    if (times.length) cancelCheck = schedule(() => {
      cancelCheck = null;
      pump();
    }, Math.max(0, Math.min(...times) - clock()));
  }

  function pump(): void {
    expire();
    if (paused) {
      if (!away && probeAt !== null && probeAt <= clock()) {
        probeAt = null;
        void demand(true, true).catch(() => undefined);
      }
    } else if (!current) {
      if (!away && !pending && listeners.size > 0 && nextCheck !== null && nextCheck <= clock()) void demand(true).catch(() => undefined);
      if (!away && !pending && listeners.size > 0 && staleAt !== null && posting === 0 && postedAt + 10_000 <= clock()) {
        staleAt = null;
        void demand(true).catch(() => undefined);
      }
      if (pending && (!pending.automatic || (!away && spaced() <= clock() && budgetAt(1, true) <= clock()))) {
        const job = pending;
        pending = null;
        current = job;
        void runList(job);
      }
      if (!current && !pending) startEvents();
      if (!current && !pending && !mailRunning && spaced() <= clock() && budgetAt(1, true) <= clock()) {
        const due = mailDue();
        if (due) void runMail(due);
      }
      if (chatOn && !current && !pending && !mailRunning && chatPart && !chatPart.running()) {
        const chatJob = chatPart.due();
        if (chatJob && (chatJob.kind !== "list" || spaced() <= clock()) && budgetAt(chatJob.kind === "read" ? 3 : 1, true) <= clock()) void chatPart.run(chatJob);
      }
    }
    arm();
  }

  function demand(automatic = false, probe = false): Promise<World> {
    expire();
    if (paused && !probe) return Promise.reject(new SignInRequired());
    if (current) return current.promise;
    if (!automatic && budgetAt(1, false) > clock()) return Promise.reject(new RateLimited());
    if (pending) {
      if (!automatic) pending.automatic = false;
      pump();
      return (current ?? pending)!.promise;
    }
    let resolve!: (world: World) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<World>((yes, no) => { resolve = yes; reject = no; });
    const job: ListJob = { automatic, probe, generation, sent: -Infinity, status: 0, promise, resolve, reject };
    pending = job;
    if (probe) {
      pending = null;
      current = job;
      void runList(job);
    } else pump();
    return promise;
  }

  function settleAnswered(items: ListedCard[]): void {
    const listedNow = new Map(items.map((item) => [item.id, item]));
    for (const [id, mark] of answered) {
      const item = listedNow.get(id);
      if (!item || item.state === "done" || (item.rev !== undefined && item.rev > mark.rev)) answered.delete(id);
    }
  }

  function applyList(listing: CardListing, sent: number, status: number): World {
    const items = listing.cards.filter(shown);
    const marked = new Set(answered.keys());
    settleAnswered(items);
    listed = new Map(items.map((item) => [item.id, item]));
    worldReady = true;
    if (!mailFirstDone) mailFirst = true;
    paused = false;
    unconfirmed = false;
    probeAt = null;
    for (const item of items) {
      const kept = reads.get(item.id);
      if (!kept || item.rev === undefined || item.rev <= kept.rev) continue;
      if (item.id !== onScreen) reads.delete(item.id);
      else if (!away && tried.get(item.id) !== item.rev) {
        tried.set(item.id, item.rev);
        if (!marked.has(item.id)) void readCard(item.id, true).catch(() => undefined);
      }
    }
    if (staleAt !== null && sent >= staleAt) staleAt = null;
    if ((status === 200 || (status === 304 && streamAway)) && !stopEvents) wantStream = true;
    appliedAt = clock();
    afterCheck();
    return worldOf(items, seen, reads, answered, mailFor, chatOn ? (chatPart?.bots() ?? []) : []);
  }

  function takeToken(mine: number, epoch: number): TokenList {
    return (listing, sent) => {
      if (mine !== generation || epoch !== privateEpoch || paused || unconfirmed) return;
      if (sent !== undefined && clock() >= sent + 61_000) return;
      const world = applyList(listing, sent ?? clock(), 200);
      if (pending?.automatic) {
        const job = pending;
        pending = null;
        job.resolve(world);
      }
      publish(world);
      arm();
    };
  }

  async function runList(job: ListJob): Promise<void> {
    try {
      const listing = await client.cards(job.automatic);
      if (job.generation !== generation) throw new SignInRequired();
      if (clock() >= job.sent + 61_000 || (unconfirmed && job.status !== 200)) {
        if (paused) {
          client.discard();
          throw new SignInRequired();
        }
        hide();
        throw new SessionUnconfirmed();
      }
      const world = applyList(listing, job.sent, job.status);
      job.resolve(world);
      publish(world);
    } catch (error) {
      if (job.generation === generation) {
        if (error instanceof SignInRequired && !paused) sessionEnded();
        else if (!paused) {
          afterCheck(true);
          notify(unconfirmed ? new SessionUnconfirmed() : error instanceof Error ? error : new Error("The server is not answering."));
        }
      }
      job.reject(error);
    } finally {
      if (current === job) {
        current = null;
        if (!paused) startEvents();
      }
      arm();
    }
  }

  client.bindSession({
    async request(meta, send) {
      expire();
      const mine = generation;
      const job = meta.kind === "list" ? current : null;
      if (paused && !job?.probe) throw new SignInRequired();
      if (unconfirmed && meta.kind !== "list" && meta.kind !== "token") throw new SessionUnconfirmed();
      const cost = meta.kind === "post" ? 2 : 1;
      if (budgetAt(cost, meta.automatic) > clock()) throw new RateLimited();
      const sent = clock();
      meta.sent = sent;
      credits.push({ at: sent, cost });
      if (meta.kind === "list" || meta.kind === "token") {
        lastListAt = sent;
        if (job) job.sent = sent;
      }
      if (meta.kind === "mail") lastMailAt = sent;
      if (chatOn && meta.kind === "chat") lastChatAt = sent;
      if (meta.kind === "post") posting += 1;
      try {
        const response = await send();
        if (response.status === 401 || response.status === 403) sessionEnded();
        else if (mine === generation) {
          if (job) job.status = response.status;
          if (response.status === 200 || response.status === 304) confirmedAt = Math.max(confirmedAt ?? -Infinity, sent);
          if (meta.kind === "post" && response.status === 200) postedAt = Math.max(postedAt, clock());
        }
        return response;
      } finally {
        if (meta.kind === "post") posting -= 1;
        expire();
        arm();
      }
    },
  });

  visibility.watch(() => {
    const hidden = visibility.hidden();
    if (hidden === away) return;
    away = hidden;
    if (away) {
      if (stopEvents || wantStream) streamAway = true;
      closeEvents();
      wantStream = false;
    } else if (!paused) {
      nextCheck = clock();
      if (mailOnScreen()) mailWanted = true;
      if (chatOn) chatPart?.back();
    }
    pump();
  });

  async function read<T>(request: () => Promise<T>): Promise<T> {
    const mine = generation;
    const epoch = privateEpoch;
    const value = await request();
    if (mine !== generation) throw new SignInRequired();
    access();
    if (epoch !== privateEpoch) throw new SessionUnconfirmed();
    return value;
  }

  async function readCard(id: string, automatic: boolean): Promise<void> {
    if (!listed.has(id)) throw new NotFound();
    const value = await read(() => client.card(id, automatic));
    reads.set(id, value);
    automaticLoad = automatic;
    arrival = !automatic;
    try { notify(); }
    finally {
      automaticLoad = false;
      arrival = false;
    }
  }

  function openCard(id: string): Promise<void> {
    onScreen = id;
    return readCard(id, false);
  }

  function closeCard(id: string): void {
    if (onScreen === id) onScreen = null;
  }

  const loadMail = (): Promise<MailLib> => (mailLib ? Promise.resolve(mailLib) : import("./mail-client").then((lib) => (mailLib = lib)));

  const mailOnScreen = (): boolean => mailListOpen || mailThreadsOpen.size > 0;

  const mailKey = (item: MailListed): string => item.lastAt + "|" + item.count;

  const mailFor = (places: { projects: Project[]; lanes: Lane[] }): MailThread[] => (mailLib ? mailLib.mailWorld(mailList, mailReads, places) : []);

  function currentWorld(): World {
    return worldOf([...listed.values()], seen, reads, answered, mailFor, chatOn ? (chatPart?.bots() ?? []) : []);
  }

  function republish(): void {
    if (worldReady) publish(currentWorld());
    else notify();
  }

  function mailDue(): { ref: string | null } | null {
    if (paused || unconfirmed || away || listeners.size === 0) return null;
    if (mailFirst || (mailWanted && mailOnScreen())) return { ref: null };
    if (!mailLib) return null;
    for (const ref of mailThreadsOpen) {
      const item = mailList?.find((one) => one.ref === ref);
      const kept = mailReads.get(ref);
      if (item && kept && mailLib.changedSince(item, kept) && mailTried.get(ref) !== mailKey(item) && !mailFlights.has(ref)) return { ref };
    }
    return null;
  }

  async function readMailList(automatic: boolean): Promise<void> {
    access();
    await loadMail();
    const value = await read(() => client.mailList(automatic));
    const known = new Set(value.threads.map((item) => item.ref));
    mailList = value.threads;
    for (const ref of [...mailReads.keys()]) {
      if (!known.has(ref)) {
        mailReads.delete(ref);
        mailTried.delete(ref);
      }
    }
    mailFirstDone = true;
    mailFirst = false;
    mailWanted = false;
    republish();
  }

  function openList(): Promise<void> {
    if (mailListFlight) return mailListFlight;
    const flight: Promise<void> = readMailList(false).finally(() => { if (mailListFlight === flight) mailListFlight = null; });
    mailListFlight = flight;
    return flight;
  }

  async function readMailThread(ref: string, automatic = false): Promise<void> {
    access();
    if (mailList === null) await openList();
    if (!mailList?.some((item) => item.ref === ref)) throw new NotFound();
    await loadMail();
    const value = await read(() => client.mailThread(ref, automatic));
    mailReads.set(ref, value);
    republish();
  }

  function openThread(ref: string): Promise<void> {
    const held = mailFlights.get(ref);
    if (held) return held;
    const flight: Promise<void> = readMailThread(ref).finally(() => { if (mailFlights.get(ref) === flight) mailFlights.delete(ref); });
    mailFlights.set(ref, flight);
    return flight;
  }

  async function openMailList(): Promise<void> {
    mailListOpen = true;
    await openList();
  }

  function closeMailList(): void {
    mailListOpen = false;
    if (!mailOnScreen()) mailWanted = false;
    arm();
  }

  async function openMailThread(ref: string): Promise<void> {
    mailThreadsOpen.add(ref);
    await openThread(ref);
  }

  function closeMailThread(ref: string): void {
    mailThreadsOpen.delete(ref);
    if (!mailOnScreen()) mailWanted = false;
    arm();
  }

  async function runMail(due: { ref: string | null }): Promise<void> {
    mailRunning = true;
    mailFirst = false;
    mailFirstDone = true;
    mailWanted = false;
    try {
      if (due.ref === null) await readMailList(true);
      else {
        const item = mailList?.find((one) => one.ref === due.ref);
        if (item) mailTried.set(due.ref, mailKey(item));
        await readMailThread(due.ref, true);
      }
    } catch {
      return;
    } finally {
      mailRunning = false;
      arm();
    }
  }

  async function foundSent(cardId: string, input: AnswerInput, pick: string): Promise<Answer | null> {
    try {
      await readCard(cardId, false);
    } catch (error) {
      if (error instanceof SignInRequired) throw error;
      return null;
    }
    const kept = reads.get(cardId);
    const hit = kept?.thread.find((event): event is Extract<CardEvent, { kind: "answer" }> => event.kind === "answer" && !event.forComment && event.rev === input.version && event.pick === pick && (event.note ?? "") === input.note);
    if (!kept || !hit) return null;
    return { choice: input.choice, at: hit.sent, note: input.note, version: input.version, waitingOn: null, outcome: null, stale: kept.rev > input.version };
  }

  function keep(cardId: string, given: Answer, rev: number, mine: number, epoch: number): Answer {
    if (mine === generation && epoch === privateEpoch) {
      answered.set(cardId, { given, rev });
      republish();
    }
    return given;
  }

  async function answer(cardId: string, input: AnswerInput): Promise<Answer> {
    access();
    const mine = generation;
    const epoch = privateEpoch;
    const item = listed.get(cardId);
    if (!item) throw new NotFound();
    const pick = pickOf(input.choice);
    const kept = reads.get(cardId);
    if (kept && kept.rev === input.version && input.choice.kind === "option") {
      const letter = input.choice.letter;
      if (!detailOf(kept, cardOf(item, null)).options.some((option) => option.letter === letter)) throw new Refused("Not sent: that revision has no option " + letter + ".");
    }
    let known = Math.max(item.rev ?? 0, kept?.rev ?? 0);
    let receipt: AnswerSent;
    const apply = takeToken(mine, epoch);
    try {
      receipt = await client.answer(cardId, { rev: input.version, pick, note: input.note }, (listing, sent) => {
        apply(listing, sent);
        known = Math.max(known, listed.get(cardId)?.rev ?? 0, reads.get(cardId)?.rev ?? 0);
      });
    } catch (error) {
      if (mine !== generation) throw new SignInRequired();
      const found = error instanceof NotConfirmed ? await foundSent(cardId, input, pick) : null;
      if (mine !== generation) throw new SignInRequired();
      if (found) return keep(cardId, found, Math.max(known, reads.get(cardId)?.rev ?? 0), mine, epoch);
      throw error;
    }
    if (mine !== generation) throw new SignInRequired();
    return keep(cardId, { choice: input.choice, at: new Date(clock()).toISOString(), note: input.note, version: receipt.rev, waitingOn: null, outcome: null, stale: receipt.stale }, Math.max(known, receipt.rev), mine, epoch);
  }

  async function comment(cardId: string, input: CommentInput): Promise<void> {
    access();
    const mine = generation;
    if (!listed.has(cardId)) throw new NotFound();
    await client.comment(cardId, input, takeToken(generation, privateEpoch));
    if (mine !== generation) throw new SignInRequired();
  }

  function servedByRecentList(): boolean {
    expire();
    return arrival && worldReady && !paused && !unconfirmed && clock() < appliedAt + 10_000 && clock() < postedAt + 10_000;
  }

  function load(): Promise<World> {
    if (delivery) return delivery;
    if (servedByRecentList()) return Promise.resolve(currentWorld());
    return demand(automaticLoad);
  }

  let serverChatApi: ServerChatApi | undefined;
  if (typeof __QD_CHAT__ !== "undefined" && __QD_CHAT__ === "on") {
    const loadChat = (): Promise<ChatPart> => {
      if (chatPart) return Promise.resolve(chatPart);
      chatLoad ??= import("./server-chat").then((lib) => {
        if (!client.chat) throw new Refused(NOT_BUILT);
        const host: ChatHost = { chat: client.chat, clock, schedule, access, read, live: () => !paused && !unconfirmed && !away && listeners.size > 0, arm, republish, token: () => takeToken(generation, privateEpoch), generation: () => generation, epoch: () => privateEpoch };
        chatPart = lib.createServerChat(host);
        return chatPart;
      });
      return chatLoad;
    };
    const watch = (register: (part: ChatPart) => () => void): (() => void) => {
      let stop: (() => void) | null = null;
      let live = true;
      void loadChat().then((part) => { if (live) stop = register(part); }, () => undefined);
      return () => {
        live = false;
        stop?.();
        stop = null;
      };
    };
    serverChatApi = {
      uploadBoundary: "server",
      listChats: () => loadChat().then((part) => part.api.listChats()),
      watchChats: (onChange) => watch((part) => part.api.watchChats(onChange)),
      openThread: (bot) => loadChat().then((part) => part.api.openThread(bot)),
      subscribe: (bot, onChange) => watch((part) => part.api.subscribe(bot, onChange)),
      older: (bot) => loadChat().then((part) => part.api.older(bot)),
      send: (bot, message) => loadChat().then((part) => part.api.send(bot, message)),
    };
  }

  return {
    now: clock,
    load,
    watch(onChange) {
      const listener = (failure?: Error) => onChange(failure);
      listeners.add(listener);
      expire();
      pump();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          closeEvents();
          if (!paused) {
            cancelCheck?.();
            cancelCheck = null;
          }
        }
      };
    },
    openCard,
    closeCard,
    limited: () => budgetAt(1, false) > clock(),
    openMailList,
    closeMailList,
    openMailThread,
    closeMailThread,
    answer,
    comment,
    freshUntil: () => client.freshUntil(),
    signIn() {
      if (!paused) return;
      cancelCheck?.();
      cancelCheck = null;
      generation += 1;
      pending?.reject(new SignInRequired());
      current?.reject(new SignInRequired());
      pending = null;
      current = null;
      probeAt = null;
      nextCheck = null;
      confirmedAt = null;
      closeEvents();
      wantStream = false;
      paused = false;
    },
    startSignIn: () => pages.goTo(SIGN_IN_PATH),
    markSeen(cardId) {
      seen.set(cardId, new Date(clock()).toISOString());
      writeJson(SEEN_KEY, Object.fromEntries(seen));
    },
    markLooked: () => undefined,
    trackers: () => Promise.resolve({}),
    openPage: notBuilt,
    publishPage: notBuilt,
    unpublishPage: notBuilt,
    evidence: () => Promise.resolve(null),
    chat: chatOn ? serverChatApi! : stubChat,
    bots: () => import("./server-bots").then((lib) => (botsPart ??= lib.createServerBots({ call: (meta, path, init) => client.call(meta, path, init), clock, schedule, goTo: (path) => pages.goTo(path) })).api),
    secrets,
    async signOut() {
      const csrf = await client.signOutToken().catch(() => null);
      forgetLocal();
      if (csrf !== null) {
        pages.postForm(SIGN_OUT_PATH, { csrf });
        return new Promise<never>(() => undefined);
      }
      sessionEnded();
      probeAt = null;
      arm();
    },
  };
}
