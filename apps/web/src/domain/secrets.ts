import { clockTime } from "./time";

export type SecretRow = { id: string; botId: string; name: string; savedAt: string; lastUsedAt: string | null; locked: boolean };

export type RequestStatus = "asking" | "saved" | "declined" | "ended";

export type SecretRequest = { id: string; botId: string; name: string; reason: string; consumerId: string; at: string; status: RequestStatus };

export type SecretEvent = { id: string; botId: string; kind: "saved" | "declined" | "ended"; name: string; at: string };

export const MAX_NAME_CHARS = 60;
export const MAX_VALUE_CHARS = 8192;
export const MAX_REASON_CHARS = 300;

export const SECRET_TEXT = {
  nameHint: "Name this secret. Do not paste the value into the name.",
  saveFailed: "Could not save the secret. It was not saved. Try again.",
  replaceFailed: "Could not replace the secret. The old one is still saved. Try again.",
  declined: "Secret request declined.",
  locked: "Locked: bot removed",
  pasteWarning: "This looks like a secret. It was not added to your message.",
  pasteAgain: "Paste it again to add it as a normal message. It will be kept in chat and the bot may see it.",
  useSecretBox: "Use a secret box",
  sendAnyway: "Send anyway",
  unavailable: "The secret box is not ready yet. The pasted text was removed and nothing was sent.",
  save: "Save securely",
  decline: "Decline",
};

export const secretText = {
  card: (bot: string) => {
    const checked = checkSecretBotLabel(bot);
    return "Secret for " + (checked.ok ? checked.text : "Bot");
  },
  suggestedName: (name: string) => {
    const checked = checkSecretName(name);
    return { label: "Suggested name from the bot:", quote: checked.ok ? checked.name : "Request text unavailable." };
  },
  reason: (bot: string, reason: string) => {
    const checkedBot = checkSecretBotLabel(bot);
    const checkedReason = checkSecretReason(reason);
    return { label: "Reason from " + (checkedBot.ok ? checkedBot.text : "Bot") + ":", quote: checkedReason.ok ? checkedReason.text : "Request text unavailable." };
  },
  note: "Saved outside chat. The named bot can use it through Quarterdeck, but cannot reveal the value. It stays until you replace or delete it.",
  saved: (name: string, bot: string, at: string) => "Secret saved: " + name + ", for " + bot + ", " + clockTime(at),
  ended: (bot: string) => "This request ended. Ask " + bot + " to request it again.",
  none: (bot: string) => "No secrets saved for " + bot + ".",
  lockedWhy: (bot: string) => "This secret is locked because " + bot + " was removed. Delete it or add a new secret after the bot returns.",
  useFailed: (bot: string, name: string) => bot + " could not use " + name + ". The value was not shown.",
  deleteConfirm: (name: string, bot: string) => "Delete " + name + "? " + bot + " will lose access now. This cannot undo uses that already happened.",
  deleted: (bot: string) => "Deleted. " + bot + " can no longer use this secret.",
  taken: (name: string, bot: string) => bot + " already has a secret named " + name + ". Replace it instead.",
};

export const ALLOWED_PROMISES = [
  "Saved outside chat.",
  "Encrypted before it is stored.",
  "Only <bot> can ask Quarterdeck to use it.",
  "Other bots cannot use it.",
  "The value is not shown again. Replace it to change it.",
  "Delete stops future Quarterdeck use.",
];

export const FORBIDDEN_PROMISES = [
  "Only you can access it.",
  "Quarterdeck cannot decrypt it.",
  "The bot can never misuse it.",
  "End-to-end encrypted.",
  "Zero knowledge.",
  "Deleted forever.",
  "Never leaves your device.",
  "Every pasted secret will be caught.",
  "Safe to send anyway.",
];

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

export type ValueCheck = { ok: true } | { ok: false; reason: string };

export type TextCheck = { ok: true; text: string } | { ok: false; reason: string };

const REQUEST_CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const REQUEST_WORD_SPAN = 12;
const REQUEST_LIMITER = /^(?:no|not|never|cannot|nobody|noone|only|solely|exclusively|alone|unable|impossible|incapable)$/;
const REQUEST_SECRET_WORD = /^(?:secrets?|values?|keys?|tokens?|passwords?|credentials?)$/;
const REQUEST_ENCRYPTION = /^encrypt/;
const REQUEST_ACTION = /^(?:sav|replac|delet|declin|cancel)/;
const REQUEST_FAMILIES = [
  [/^(?:quarterdeck|we|us|you|captain|owner|operator|nobody|noone|bots?|agents?|server)$/, REQUEST_LIMITER, /^(?:decrypt|read|see|seen|access|stor|keep|kept|log|shar|view)/],
  [/^(?:bots?|agents?)$/, REQUEST_LIMITER, /^(?:misus|abus|exploit)/],
  [/^(?:e2e|end2end|endtoend)$/, REQUEST_ENCRYPTION],
  [/^(?:zero|no|none|nothing|nobody)$/, /^know(?:ledge|n|s|ing)?$/],
  [/^(?:delet|eras|remov|wip)/, /^(?:forever|permanen|irreversib|irrevocab)/],
  [REQUEST_LIMITER, /^(?:devices?|phones?|computers?|browsers?|machines?|local|locally)$/, /^(?:leav|left|exit|send|sent|stay|remain|keep|kept|stor)/],
  [/^(?:every|all|any|always|each)$/, /^(?:detect|catch|caught|block|stop|warn|flag)/, REQUEST_SECRET_WORD],
  [/^(?:every|all|any|always|each)$/, /^(?:detect|catch|caught|block|stop|warn|flag)/, /^(?:past|clipboard)/],
  [/^(?:safe|safely|secur)/, /^(?:send|sent|post|past|shar)/, /^(?:chat|messages?|anyway|normal)$/],
  [REQUEST_SECRET_WORD, /^(?:sav(?:ed|ing)|stor(?:ed|ing)|encrypt(?:ed|ing)|approv(?:ed|ing|al)|verif(?:ied|ying|ication)|delet(?:ed|ing)|replac(?:ed|ing)|locked)$/],
  [/^requests?$/, /^(?:declin|cancel|approv|ended)/],
  [/^(?:bots?|agents?)$/, /^(?:lock|remov)/],
  [/^sav(?:e|es|ed|ing)$/, /^(?:secur|safely)/],
  [/^(?:send|sent|post)/, /^(?:anyway|regardless)$/],
  [REQUEST_SECRET_WORD, /^box(?:es)?$/, /^(?:us(?:e|ed|ing)|open|enter)/],
  [REQUEST_ACTION, /^(?:click|tap|press|button|confirm)/],
  [REQUEST_ACTION, /^please$/, REQUEST_SECRET_WORD],
];

function hasNearbyWords(words: readonly string[], patterns: readonly RegExp[]): boolean {
  const latest = patterns.map(() => -REQUEST_WORD_SPAN);
  for (let at = 0; at < words.length; at += 1) {
    let earliest = at;
    for (let part = 0; part < patterns.length; part += 1) {
      if (patterns[part].test(words[at])) latest[part] = at;
      earliest = Math.min(earliest, latest[part]);
    }
    if (at - earliest < REQUEST_WORD_SPAN) return true;
  }
  return false;
}

function claimsEndToEndEncryption(words: readonly string[]): boolean {
  let latestEnd = -REQUEST_WORD_SPAN;
  let previousEnd = -REQUEST_WORD_SPAN;
  let encryption = -REQUEST_WORD_SPAN;
  for (let at = 0; at < words.length; at += 1) {
    if (words[at] === "end") {
      previousEnd = latestEnd;
      latestEnd = at;
    }
    if (REQUEST_ENCRYPTION.test(words[at])) encryption = at;
    if (at - Math.min(previousEnd, encryption) < REQUEST_WORD_SPAN) return true;
  }
  return false;
}

function impersonatesSecretUi(text: string): boolean {
  const normalized = text.toLowerCase().replace(/n['’]t\b/gu, " not").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\bno one\b/gu, "nobody").trim();
  const words = normalized.split(/\s+/u);
  return claimsEndToEndEncryption(words) || REQUEST_FAMILIES.some((family) => hasNearbyWords(words, family)) || (words.length === 1 && REQUEST_ACTION.test(words[0]));
}

const SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b[spr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

const TOKEN = /^[A-Za-z0-9+/=_-]{24,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTROPY_FLOOR = 3.5;
const SWITCH_FLOOR = 0.45;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

function classOf(char: string): number {
  if (char >= "a" && char <= "z") return 0;
  if (char >= "A" && char <= "Z") return 1;
  return char >= "0" && char <= "9" ? 2 : 3;
}

function switchRate(text: string): number {
  let switches = 0;
  for (let at = 1; at < text.length; at += 1) if (classOf(text[at]) !== classOf(text[at - 1])) switches += 1;
  return switches / (text.length - 1);
}

function tokenLooksRandom(token: string): boolean {
  if (!TOKEN.test(token) || UUID.test(token)) return false;
  const mixed = /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token) && switchRate(token) >= SWITCH_FLOOR;
  const hex = token.length >= 32 && /^[0-9a-f]+$/i.test(token);
  return (mixed || hex) && entropy(token) >= ENTROPY_FLOOR;
}

export function looksLikeSecret(text: string): boolean {
  if (SHAPES.some((shape) => shape.test(text))) return true;
  for (const [token] of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) if (tokenLooksRandom(token)) return true;
  return false;
}

export function checkSecretName(raw: string): NameCheck {
  if (REQUEST_CONTROLS.test(raw)) return { ok: false, reason: "A name is one line of plain text." };
  const name = raw.trim();
  if (!name) return { ok: false, reason: "Give the secret a name." };
  if (name.length > MAX_NAME_CHARS) return { ok: false, reason: "A name can be up to " + MAX_NAME_CHARS + " characters." };
  if (impersonatesSecretUi(name)) return { ok: false, reason: "A name cannot be an app status, action or privacy promise." };
  if (looksLikeSecret(name)) return { ok: false, reason: SECRET_TEXT.nameHint };
  return { ok: true, name };
}

export function checkSecretValue(value: string): ValueCheck {
  if (!value) return { ok: false, reason: "Enter the secret." };
  if (value.length > MAX_VALUE_CHARS) return { ok: false, reason: "That is longer than a secret can be." };
  return { ok: true };
}

export function checkSecretReason(raw: string): TextCheck {
  if (REQUEST_CONTROLS.test(raw)) return { ok: false, reason: "A reason is one line of plain text." };
  const reason = raw.trim();
  if (!reason) return { ok: false, reason: "A request needs a reason in plain words." };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, reason: "A reason can be up to " + MAX_REASON_CHARS + " characters." };
  if (impersonatesSecretUi(reason)) return { ok: false, reason: "A reason cannot be an app status, action or privacy promise." };
  if (looksLikeSecret(reason)) return { ok: false, reason: "A reason is plain words, not a secret value." };
  return { ok: true, text: reason };
}

export function checkSecretBotLabel(raw: string): TextCheck {
  const checked = checkSecretName(raw);
  return checked.ok ? { ok: true, text: checked.name } : { ok: false, reason: "A bot label must be plain text without a status or privacy promise." };
}

export function savedLine(event: SecretEvent, botName: string): string {
  return secretText.saved(event.name, botName, event.at);
}
