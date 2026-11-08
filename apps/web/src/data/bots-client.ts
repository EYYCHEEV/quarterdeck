import { BOTS_WORDS } from "../domain/bot-joins";
import { FreshSignInRequired, NotConfirmed, Refused, SignInRequired } from "./source";

export { BOTS_WORDS, endsText, spacedCode } from "../domain/bot-joins";

type Raw = Record<string, unknown>;

export type ListedJoin = { code: string; name: string; invitedBy: string; at: string; ends: string };

export type ListedInvite = { id: string; forName: string | null; by: string; ends: string };

export type ListedBot = { id: string; name: string };

export type BotsList = { pending: ListedJoin[]; invites: ListedInvite[]; joined: ListedBot[]; approveHere: boolean; csrf: string; freshUntil: number };

export type BotsReceipt = { csrf: string; freshUntil: number };

export type MadeListedInvite = Omit<ListedInvite, "by">;

export type InviteReceipt = BotsReceipt & { invite: MadeListedInvite; code: string; prompt: string };

export type BotsAction = "refuse" | "invite" | "cancel";

const CODE = /^[2-9A-HJ-NP-Z]{8}$/;
const NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[\w.-]{1,64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_TEXT = 64;
const MAX_TOKEN = 512;
const MAX_PROMPT = 4096;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const unreadable = (what: string) => new Refused("The server's answer could not be read: " + what + ".");

function textOf(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT || CONTROL.test(value)) throw unreadable(what);
  return value;
}

function matching(value: unknown, rule: RegExp, what: string): string {
  if (typeof value !== "string" || !rule.test(value)) throw unreadable(what);
  return value;
}

function timeOf(value: unknown, what: string): string {
  if (typeof value !== "string" || !TIME.test(value) || Number.isNaN(Date.parse(value))) throw unreadable(what);
  return value;
}

function forNameRead(value: unknown): string | null {
  return value === null ? null : matching(value, NAME_RULE, "an invite name");
}

function listOf<T>(raw: Raw, key: string, read: (value: unknown) => T): T[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw unreadable(key);
  return value.map(read);
}

function joinOf(value: unknown): ListedJoin {
  if (!isRecord(value)) throw unreadable("a join request");
  return { code: matching(value.code, CODE, "a join code"), name: textOf(value.name, "a join name"), invitedBy: textOf(value.invitedBy, "who invited a bot"), at: timeOf(value.at, "a join time"), ends: timeOf(value.ends, "a join end") };
}

function madeInviteOf(value: unknown): MadeListedInvite {
  if (!isRecord(value)) throw unreadable("an invite");
  return { id: matching(value.id, ID, "an invite id"), forName: forNameRead(value.forName), ends: timeOf(value.ends, "an invite end") };
}

function inviteOf(value: unknown): ListedInvite {
  if (!isRecord(value)) throw unreadable("an invite");
  return { ...madeInviteOf(value), by: textOf(value.by, "who made an invite") };
}

function botOf(value: unknown): ListedBot {
  if (!isRecord(value)) throw unreadable("a bot");
  return { id: matching(value.id, ID, "a bot id"), name: textOf(value.name, "a bot name") };
}

function tokenOf(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_TOKEN || CONTROL.test(value)) throw unreadable("the sign-in token");
  return value;
}

function freshOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw unreadable("freshUntil");
  return value;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function readBotsList(status: number, text: string): BotsList | null {
  if (status === 401 || status === 403) throw new SignInRequired();
  if (status === 404 || status === 405) return null;
  if (status !== 200) throw new NotConfirmed();
  const raw = parsed(text);
  if (raw === undefined) return null;
  if (!isRecord(raw)) throw unreadable("the bots list");
  if (typeof raw.approveHere !== "boolean") throw unreadable("approveHere");
  return { pending: listOf(raw, "pending", joinOf), invites: listOf(raw, "invites", inviteOf), joined: listOf(raw, "joined", botOf), approveHere: raw.approveHere, csrf: tokenOf(raw.csrf), freshUntil: freshOf(raw.freshUntil) };
}

function sendable(csrf: unknown): string {
  if (typeof csrf !== "string" || csrf === "") throw new Refused(BOTS_WORDS.token);
  return csrf;
}

export function refuseBody(code: string, csrf: string): string {
  const bare = code.replace(" ", "");
  if (!CODE.test(bare)) throw new Refused(BOTS_WORDS.gone);
  return JSON.stringify({ code: bare, csrf: sendable(csrf) });
}

export function inviteBody(forName: string | null, csrf: string): string {
  if (forName !== null && !NAME_RULE.test(forName)) throw new Refused(BOTS_WORDS.name);
  return JSON.stringify({ forName, csrf: sendable(csrf) });
}

export function cancelBody(id: string, csrf: string): string {
  if (!ID.test(id)) throw new Refused(BOTS_WORDS.inviteGone);
  return JSON.stringify({ id, csrf: sendable(csrf) });
}

export function forNameOf(typed: string): string | null {
  const name = typed.trim();
  if (name === "") return null;
  if (!NAME_RULE.test(name)) throw new Refused(BOTS_WORDS.name);
  return name;
}

const errorIs = (text: string, error: string): boolean => {
  const raw = parsed(text);
  return isRecord(raw) && raw.error === error;
};

function receiptOf(raw: unknown): BotsReceipt {
  if (!isRecord(raw) || typeof raw.csrf !== "string" || raw.csrf === "" || raw.csrf.length > MAX_TOKEN || typeof raw.freshUntil !== "number" || !Number.isFinite(raw.freshUntil)) throw new NotConfirmed();
  return { csrf: raw.csrf, freshUntil: raw.freshUntil };
}

function madeOf(raw: Raw, receipt: BotsReceipt): InviteReceipt {
  const { code, prompt } = raw;
  if (typeof code !== "string" || code === "" || code.length > MAX_TEXT || CONTROL.test(code)) throw new NotConfirmed();
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_PROMPT) throw new NotConfirmed();
  try {
    return { ...receipt, invite: madeInviteOf(raw.invite), code, prompt };
  } catch {
    throw new NotConfirmed();
  }
}

export function readAction(action: "invite", status: number, text: string): InviteReceipt;
export function readAction(action: BotsAction, status: number, text: string): BotsReceipt;
export function readAction(action: BotsAction, status: number, text: string): BotsReceipt | InviteReceipt {
  if (status === 303) throw new FreshSignInRequired();
  if (status === 401 || status === 403) throw new SignInRequired();
  if (status === 429) throw new Refused(BOTS_WORDS.rate);
  if (status === 404 && action !== "invite" && errorIs(text, "gone")) throw new Refused(action === "refuse" ? BOTS_WORDS.gone : BOTS_WORDS.inviteGone);
  if (status === 422 && action === "invite" && errorIs(text, "name")) throw new Refused(BOTS_WORDS.name);
  if (status !== 200) throw new NotConfirmed();
  const raw = parsed(text);
  const receipt = receiptOf(raw);
  return action === "invite" ? madeOf(raw as Raw, receipt) : receipt;
}
