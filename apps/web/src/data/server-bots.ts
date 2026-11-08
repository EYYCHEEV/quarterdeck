import { clockTime } from "../domain/time";
import { readText } from "../platform/read-text";
import type { Schedule } from "../platform/timer";
import type { SessionRequest } from "./api-client";
import { BOTS_WORDS, cancelBody, codeBody, forNameOf, inviteBody, readAction, readBotsList, spacedCode, type BotsAction, type BotsList, type BotsReceipt, type InviteReceipt, type ListedInvite, type ListedJoin } from "./bots-client";
import { FreshSignInRequired, RateLimited, Refused, SignInRequired, type BotsAdmin, type BotsApi, type BotsNotice, type MadeInvite, type OpenInvite, type PendingJoin } from "./source";

export type BotsHost = {
  call: (meta: SessionRequest, path: string, init: RequestInit) => Promise<Response>;
  clock: () => number;
  schedule: Schedule;
  goTo: (path: string) => void;
};

export type BotsPart = { api: BotsApi; clear: () => void };

const LIST_PATH = "/captain/api/bots";
const PATHS: Record<BotsAction, string> = { approve: LIST_PATH + "/approve", refuse: LIST_PATH + "/refuse", invite: LIST_PATH + "/invites", cancel: LIST_PATH + "/invites/cancel" };
const STEP_UP = "/captain/step-up?next=/settings/bots";
const POST_TIMEOUT = 20_000;
const LIST_LIMIT = 1_048_576;
const ANSWER_LIMIT = 16_384;

const EMPTY: BotsAdmin = { notes: {}, pending: [], invites: [], joined: [], removed: {}, history: [], password: false, pinned: {}, cleanup: { on: false, days: 30 }, state: "loading", approveHere: false, busy: false, notice: null };

const who = (name: string) => (name === "Captain" ? "you" : name);

const joinOf = (join: ListedJoin): PendingJoin => ({ id: join.code, name: join.name, invitedBy: who(join.invitedBy), at: clockTime(join.at), code: spacedCode(join.code), inviteId: null, endsAt: join.ends });

const inviteOf = (invite: ListedInvite): OpenInvite => ({ id: invite.id, forName: invite.forName, by: who(invite.by), ends: "", endsAt: invite.ends });

const noticeOf = (error: unknown): BotsNotice => (error instanceof Refused ? { words: error.message, again: false } : error instanceof RateLimited ? { words: BOTS_WORDS.rate, again: false } : { words: BOTS_WORDS.failed, again: true });

export function createServerBots(host: BotsHost): BotsPart {
  let epoch = 0;
  let snapshot = EMPTY;
  let list: BotsList | null = null;
  let started = 0;
  let shown = 0;
  let reading: Promise<void> | null = null;
  let acting = false;
  let last: (() => Promise<void>) | null = null;
  let stopTimer: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function publish(next: Partial<BotsAdmin>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  }

  function view(): void {
    stopTimer?.();
    stopTimer = null;
    if (!list) return;
    const now = host.clock();
    const ends = [...list.pending, ...list.invites].map((one) => Date.parse(one.ends)).filter((at) => at > now);
    if (ends.length) {
      stopTimer = host.schedule(() => {
        stopTimer = null;
        view();
      }, Math.min(...ends) - now);
    }
    publish({
      state: "ready",
      pending: list.pending.filter((one) => Date.parse(one.ends) > now).map(joinOf),
      invites: list.invites.filter((one) => Date.parse(one.ends) > now).map(inviteOf),
      joined: list.joined.map((bot) => ({ id: bot.id, name: bot.name, role: "", at: "" })),
      approveHere: list.approveHere,
    });
  }

  function drop(state: BotsAdmin["state"]): void {
    stopTimer?.();
    stopTimer = null;
    list = null;
    publish({ state, pending: [], invites: [], joined: [] });
  }

  async function fetchList(): Promise<BotsList | null> {
    const response = await host.call({ kind: "bots", automatic: false }, LIST_PATH, { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin", redirect: "error" });
    const { text, cut } = await readText(response, LIST_LIMIT, true);
    if (cut) throw new Refused(BOTS_WORDS.list);
    return readBotsList(response.status, text);
  }

  function newest(seq: number): boolean {
    if (seq < shown) return false;
    shown = seq;
    return true;
  }

  function apply(answer: BotsList | null): void {
    if (answer === null) {
      drop("approval");
      return;
    }
    list = answer;
    view();
  }

  async function readOnce(mine: number): Promise<void> {
    const seq = (started += 1);
    let answer: BotsList | null;
    try {
      answer = await fetchList();
    } catch (error) {
      if (mine === epoch && !(error instanceof SignInRequired) && newest(seq)) drop("failed");
      return;
    }
    if (mine === epoch && newest(seq)) apply(answer);
  }

  function read(): Promise<void> {
    if (reading) return reading;
    const going = readOnce(epoch).finally(() => {
      if (reading === going) reading = null;
    });
    reading = going;
    return going;
  }

  async function readAfter(): Promise<void> {
    if (reading) await reading;
    await read();
  }

  function settle(mine: number, notice: BotsNotice | null): void {
    if (mine !== epoch) return;
    acting = false;
    publish({ busy: false, notice });
  }

  async function post(action: "invite", body: (token: string) => string): Promise<InviteReceipt | null>;
  async function post(action: BotsAction, body: (token: string) => string): Promise<BotsReceipt | null>;
  async function post(action: BotsAction, body: (token: string) => string): Promise<BotsReceipt | InviteReceipt | null> {
    if (acting) return null;
    const mine = epoch;
    acting = true;
    publish({ busy: true, notice: null });
    const seq = (started += 1);
    let token: string;
    try {
      const listed = await fetchList();
      if (mine !== epoch) return null;
      if (newest(seq)) apply(listed);
      if (listed === null) {
        settle(mine, null);
        return null;
      }
      if (action === "approve" && !listed.approveHere) {
        settle(mine, null);
        return null;
      }
      token = listed.csrf;
    } catch (error) {
      settle(mine, error instanceof SignInRequired ? null : noticeOf(error));
      return null;
    }
    const controller = new AbortController();
    const stop = host.schedule(() => controller.abort(), POST_TIMEOUT);
    let receipt: BotsReceipt | InviteReceipt | null = null;
    let notice: BotsNotice | null = null;
    try {
      const sent = body(token);
      const response = await host.call({ kind: "post", automatic: false }, PATHS[action], { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: sent, credentials: "same-origin", redirect: "manual", signal: controller.signal });
      const { text } = await readText(response, ANSWER_LIMIT, true);
      receipt = readAction(action, response.type === "opaqueredirect" ? 303 : response.status, text);
    } catch (error) {
      if (error instanceof FreshSignInRequired || error instanceof SignInRequired) {
        settle(mine, null);
        if (error instanceof FreshSignInRequired && mine === epoch) host.goTo(STEP_UP);
        return null;
      }
      notice = noticeOf(error);
    } finally {
      stop();
    }
    if (mine !== epoch) return null;
    await readAfter();
    settle(mine, notice);
    return mine === epoch ? receipt : null;
  }

  async function again(run: () => Promise<unknown>): Promise<void> {
    last = null;
    await run();
    if (snapshot.notice?.again) last = () => again(run);
  }

  const api: BotsApi = {
    current: () => snapshot,
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) void read();
      return () => {
        listeners.delete(onChange);
      };
    },
    reload() {
      if (snapshot.state === "failed") publish({ state: "loading" });
      return read();
    },
    again: () => (last && !acting ? last() : Promise.resolve()),
    clearNotice() {
      if (snapshot.notice) publish({ notice: null });
    },
    async createInvite(typed): Promise<MadeInvite | null> {
      let forName: string | null;
      try {
        forName = forNameOf(typed);
      } catch (error) {
        publish({ notice: { words: error instanceof Error ? error.message : BOTS_WORDS.name, again: false } });
        return null;
      }
      const made = await post("invite", (token) => inviteBody(forName, token));
      return made ? { invite: inviteOf({ ...made.invite, by: "Captain" }), code: made.code, prompt: made.prompt } : null;
    },
    refuseJoin: (code) => (acting ? Promise.resolve() : again(() => post("refuse", (token) => codeBody(code, token)))),
    cancelInvite: (id) => (acting ? Promise.resolve() : again(() => post("cancel", (token) => cancelBody(id, token)))),
    askLater: () => undefined,
    async approveJoin(code) {
      if (!acting) await again(() => post("approve", (token) => codeBody(code, token)));
      return null;
    },
    removeBot: () => undefined,
    setPinned(botId, pinned) {
      publish({ pinned: { ...snapshot.pinned, [botId]: pinned } });
    },
    setPassword: () => undefined,
    setCleanup(cleanup) {
      publish({ cleanup });
    },
  };

  function clear(): void {
    epoch += 1;
    stopTimer?.();
    stopTimer = null;
    list = null;
    reading = null;
    acting = false;
    last = null;
    publish(EMPTY);
  }

  return { api, clear };
}
