import { BOTS_WORDS } from "../domain/bot-joins";
import type { BotNote, BotsAdmin, BotsApi, HistoryLine, JoinedBot, MadeInvite, OpenInvite, PendingJoin } from "./source";

const JOIN_CODE = "K7P4 2Q9M";
const JOIN_TIME = "9:31 AM";
const ASK_DELAY_MS = 4000;
const INVITE = "Join Quarterdeck: install the QD MCP 1.4.2 (checked by its sha256), then run qd join and give it the invite qd-example-7F3K-92QM.";

const NOTES: Record<string, BotNote> = {
  "iris": { invitedBy: "you", joined: "Oct 30", active: "active now" },
  "alba": { invitedBy: "you", joined: "Oct 30", active: "active 2m" },
  "dr-kivo": { invitedBy: "you", joined: "Oct 31", active: "active 14m" },
  shelvorn: { invitedBy: "Iris", joined: "Nov 1", active: "active 1h" },
  "dale": { invitedBy: "Dr. Kivo", joined: "Nov 2", active: "active 3h" },
  pib: { invitedBy: "you", joined: "Oct 28", active: "removed Nov 1" },
};

function start(): BotsAdmin {
  return {
    notes: NOTES,
    pending: [{ id: "join-quorl", name: "Quorl", invitedBy: "Iris", at: JOIN_TIME, code: "M3X8 5T2R", inviteId: null }],
    invites: [
      { id: "invite-lark", forName: "Lark", by: "you", ends: "ends in 23 h" },
      { id: "invite-any", forName: null, by: "Iris", ends: "ends in 4 h" },
    ],
    joined: [],
    removed: {},
    history: [
      { id: "h1", text: "Invite for Wren ended", at: "Nov 2" },
      { id: "h2", text: "Refused. Moth was not added.", at: "Nov 2" },
      { id: "h3", text: "Dale joined, invited by Dr. Kivo", at: "Nov 2" },
      { id: "h4", text: "Shelvorn joined, invited by Iris", at: "Nov 1" },
    ],
    password: false,
    pinned: {},
    cleanup: { on: false, days: 30 },
    state: "ready",
    approveHere: true,
    busy: false,
    notice: null,
  };
}

const SERVER_PROMPT = "Join Quarterdeck: mail join@example.invalid with the invite QD7F3K92QM from the bot named tarn, within 24 hours.";

function serverLook(look: string): BotsAdmin {
  const quorl: PendingJoin = { id: "M3X85T2R", name: "quorl", invitedBy: "fern", at: "9:51 AM", code: "M3X8 5T2R", inviteId: null, endsAt: "2026-11-02T10:01:00-05:00" };
  const tarn: PendingJoin = { id: "K7P42Q9M", name: "tarn", invitedBy: "you", at: "9:58 AM", code: "K7P4 2Q9M", inviteId: null, endsAt: "2026-11-02T10:08:00-05:00" };
  return {
    ...start(),
    notes: {},
    pending: look === "refused" ? [quorl] : [tarn, quorl],
    invites: [
      { id: "inv-12charsxx", forName: "tarn", by: "you", ends: "", endsAt: "2026-11-03T09:05:00-05:00" },
      { id: "inv-anybot001", forName: null, by: "fern", ends: "", endsAt: "2026-11-02T12:30:00-05:00" },
    ],
    history: [],
    state: look === "failed" ? "failed" : "ready",
    approveHere: false,
    notice: look === "refused" ? { words: BOTS_WORDS.gone, again: false } : null,
  };
}

export function createExampleBots(): BotsApi {
  const look = __QD_FIXTURES__ ? new URLSearchParams(window.location.search).get("bots") : null;
  let current = look ? serverLook(look) : start();
  let serial = 0;
  const listeners = new Set<() => void>();
  const change = (next: BotsAdmin) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const askToJoin = (inviteId: string) => {
    const invite = current.invites.find((item) => item.id === inviteId);
    if (!invite || current.pending.some((join) => join.inviteId === inviteId)) return;
    const join: PendingJoin = { id: "join-" + inviteId, name: invite.forName ?? "Marlowe", invitedBy: "you", at: JOIN_TIME, code: JOIN_CODE, inviteId };
    change({ ...current, pending: [join, ...current.pending], invites: current.invites.filter((item) => item.id !== inviteId) });
  };
  return {
    current: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    reload: async () => undefined,
    again: async () => undefined,
    clearNotice: () => undefined,
    createInvite: async (name): Promise<MadeInvite> => {
      serial += 1;
      const invite: OpenInvite = { id: "invite-new-" + serial, forName: name.trim() || null, by: "you", ends: "ends in 24 h" };
      change({ ...current, invites: [invite, ...current.invites] });
      return { invite, code: look ? "QD7F3K92QM" : null, prompt: look ? SERVER_PROMPT : INVITE };
    },
    askLater: (inviteId) => {
      if (!look) window.setTimeout(() => askToJoin(inviteId), ASK_DELAY_MS);
    },
    cancelInvite: async (inviteId) => {
      const invite = current.invites.find((item) => item.id === inviteId);
      if (!invite) return;
      const line: HistoryLine = { id: "ended-" + inviteId, text: "Invite for " + (invite.forName ?? "any bot") + " ended", at: "Today" };
      change({ ...current, invites: current.invites.filter((item) => item.id !== inviteId), history: [line, ...current.history] });
    },
    approveJoin: (joinId) => {
      const join = current.pending.find((item) => item.id === joinId);
      if (!join) return null;
      const bot: JoinedBot = { id: join.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: join.name, role: "New bot", at: "Today" };
      const line: HistoryLine = { id: "joined-" + joinId, text: join.name + " joined, invited by " + join.invitedBy, at: "Today" };
      change({
        ...current,
        pending: current.pending.filter((item) => item.id !== joinId),
        joined: [bot, ...current.joined],
        notes: { ...current.notes, [bot.id]: { invitedBy: join.invitedBy, joined: "Today", active: "active now" } },
        history: [line, ...current.history],
      });
      return bot;
    },
    refuseJoin: async (joinId) => {
      const join = current.pending.find((item) => item.id === joinId);
      if (!join) return;
      const line: HistoryLine = { id: "refused-" + joinId, text: "Refused. " + join.name + " was not added.", at: "Today" };
      change({ ...current, pending: current.pending.filter((item) => item.id !== joinId), history: [line, ...current.history] });
    },
    removeBot: (botId, name) => {
      const line: HistoryLine = { id: "removed-" + botId, text: name + " removed", at: "Today" };
      change({ ...current, removed: { ...current.removed, [botId]: "Today" }, joined: current.joined.filter((bot) => bot.id !== botId), history: [line, ...current.history] });
    },
    setPinned: (botId, pinned) => change({ ...current, pinned: { ...current.pinned, [botId]: pinned } }),
    setPassword: (password) => change({ ...current, password }),
    setCleanup: (cleanup) => change({ ...current, cleanup }),
  };
}
