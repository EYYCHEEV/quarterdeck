import { NotConfirmed, Refused } from "./source";

export type AnswerPost = { rev: number; pick: string; note: string };

export type CommentPost = { text: string; requestId: string };

export type AnswerReceipt = { message: string; stale: boolean; rev: number; csrf: string; freshUntil: number };

export type CommentReceipt = { csrf: string; freshUntil: number };

const TEXT_LIMIT = 4000;
const BODY_LIMIT = 16384;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const LETTER = /^[A-Z]$/;

const refuse = (why: string) => new Refused("Not sent: " + why + ".");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function within(value: string, limit: number): boolean {
  if (value.length <= limit) return true;
  if (value.length > limit * 2) return false;
  let count = 0;
  for (let at = 0; at < value.length; at += 1) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < value.length) {
      const next = value.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) at += 1;
    }
    count += 1;
    if (count > limit) return false;
  }
  return true;
}

export function checkAnswer(input: AnswerPost): void {
  if (!Number.isSafeInteger(input.rev) || input.rev < 0) throw refuse("the revision is not a whole number");
  const { pick, note } = input;
  if (typeof pick !== "string" || !(LETTER.test(pick) || pick === "cant-decide" || pick === "none")) throw refuse("the pick is not an option letter, cant-decide or none");
  if (typeof note !== "string" || !within(note, TEXT_LIMIT)) throw refuse("the note is not text of at most 4000 characters");
}

export function checkComment(input: CommentPost): void {
  const { text, requestId } = input;
  if (typeof text !== "string" || text.length === 0 || !within(text, TEXT_LIMIT)) throw refuse("the comment is not 1 to 4000 characters");
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw refuse("the request id is not 1 to 80 letters, digits, _ or -");
}

function sealed(json: string, csrf: unknown): string {
  if (typeof csrf !== "string" || csrf === "") throw refuse("there is no sign-in token");
  if (new TextEncoder().encode(json).length > BODY_LIMIT) throw refuse("the request is over 16 KiB");
  return json;
}

export function answerBody(input: AnswerPost, csrf: string): string {
  checkAnswer(input);
  return sealed(JSON.stringify({ rev: input.rev, pick: input.pick, note: input.note, csrf }), csrf);
}

export function commentBody(input: CommentPost, csrf: string): string {
  checkComment(input);
  return sealed(JSON.stringify({ text: input.text, requestId: input.requestId, csrf }), csrf);
}

export function answerReceiptOf(raw: unknown): AnswerReceipt {
  if (!isRecord(raw)) throw new NotConfirmed();
  const { message, stale, rev, csrf, freshUntil } = raw;
  if (typeof message !== "string" || typeof stale !== "boolean" || typeof rev !== "number" || !Number.isSafeInteger(rev) || typeof csrf !== "string" || !isNumber(freshUntil)) throw new NotConfirmed();
  return { message, stale, rev, csrf, freshUntil };
}

export function commentReceiptOf(raw: unknown): CommentReceipt {
  if (!isRecord(raw) || raw.status !== "sent") throw new NotConfirmed();
  const { csrf, freshUntil } = raw;
  if (typeof csrf !== "string" || !isNumber(freshUntil)) throw new NotConfirmed();
  return { csrf, freshUntil };
}

export function tokenOf(raw: unknown): { csrf: string | null; freshUntil: number | null } {
  if (!isRecord(raw)) return { csrf: null, freshUntil: null };
  return { csrf: typeof raw.csrf === "string" && raw.csrf !== "" ? raw.csrf : null, freshUntil: isNumber(raw.freshUntil) ? raw.freshUntil : null };
}
