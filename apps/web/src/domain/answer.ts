import { pickOf } from "./card";
import { choiceText } from "./query";
import { clockTime } from "./time";
import type { Answer, Card, Choice } from "./types";

export type Phase = "ready" | "confirm" | "sending" | "failed";

export type AnswerState = { choice: Choice | null; note: string; phase: Phase; askedAt: number; limited?: boolean; cause?: FailCause };

export type FailCause = "unsure" | "sign-in";

export type AnswerEvent =
  | { type: "choose"; choice: Choice }
  | { type: "note"; text: string }
  | { type: "send"; at: number; choice?: Choice }
  | { type: "confirm"; at: number }
  | { type: "back" }
  | { type: "failed"; error?: unknown };

export const CONFIRM_GUARD_MS = 500;

export const SEND_LIMIT_MS = 45_000;

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "");

const causeOf = (error: unknown): FailCause | undefined => {
  const name = nameOf(error);
  return name === "TimedOut" ? "unsure" : name === "FreshSignInRequired" ? "sign-in" : undefined;
};

export type CardKey = { type: "choose"; choice: Choice } | { type: "send" } | { type: "talk" } | { type: "keys" };

const MOVE_KEYS = new Set(["j", "k"]);

export function cardKey(card: Card, key: string): CardKey | null {
  if (key === "t") return { type: "talk" };
  if (key === "?") return { type: "keys" };
  if (card.options.length === 0) return null;
  if (key === "Enter") return { type: "send" };
  if (key === "n") return { type: "choose", choice: { kind: "none" } };
  if (MOVE_KEYS.has(key) || !/^[a-z]$/.test(key)) return null;
  const letter = key.toUpperCase();
  return card.options.some((option) => option.letter === letter) ? { type: "choose", choice: { kind: "option", letter } } : null;
}

export function startAnswer(card: Card): AnswerState {
  const pick = pickOf(card);
  return { choice: pick ? { kind: "option", letter: pick.letter } : null, note: "", phase: "ready", askedAt: 0 };
}

export function carryAnswer(card: Card, state: AnswerState): AnswerState {
  const choice = state.choice;
  if (choice?.kind !== "option" || card.options.some((option) => option.letter === choice.letter)) return state;
  return { ...state, choice: null, phase: state.phase === "confirm" ? "ready" : state.phase };
}

function isOneWay(card: Card, choice: Choice): boolean {
  if (choice.kind === "approve") return card.approvalDoor === "one-way";
  if (choice.kind !== "option") return false;
  return card.options.find((option) => option.letter === choice.letter)?.door === "one-way";
}

export function answerStep(card: Card, state: AnswerState, event: AnswerEvent): AnswerState {
  if (event.type === "failed") return state.phase === "sending" ? { ...state, phase: "failed", limited: nameOf(event.error) === "RateLimited", cause: causeOf(event.error) } : state;
  if (state.phase === "sending") return state;
  const ready = state.phase === "confirm" ? "ready" : state.phase;
  switch (event.type) {
    case "choose":
      return { ...state, choice: event.choice, phase: ready };
    case "note":
      return { ...state, note: event.text, phase: ready };
    case "back":
      return { ...state, phase: "ready" };
    case "confirm":
      return state.phase === "confirm" && event.at - state.askedAt >= CONFIRM_GUARD_MS ? { ...state, phase: "sending" } : state;
    case "send": {
      const choice = event.choice ?? state.choice;
      if (!choice || state.phase === "confirm") return state;
      return isOneWay(card, choice) ? { ...state, choice, phase: "confirm", askedAt: event.at } : { ...state, choice, phase: "sending" };
    }
  }
}

export function sendButton(card: Card, state: AnswerState): { text: string; disabled: boolean } {
  if (!state.choice || state.choice.kind === "approve" || state.choice.kind === "reject") return { text: "Send", disabled: card.options.length > 0 };
  return { text: state.choice.kind === "none" ? "Send: None of these" : "Send " + choiceText(state.choice), disabled: false };
}

export function notePlaceholder(state: AnswerState): string {
  return state.choice?.kind === "none" ? "Your own answer, or what would work instead" : "Add a note (optional)";
}

export function confirmPrompt(card: Card, state: AnswerState): { question: string; button: string } {
  if (state.choice?.kind === "approve" || card.options.length === 0) return { question: "Approve? This cannot be undone.", button: "Confirm: approve" };
  const letter = state.choice ? choiceText(state.choice) : "";
  return { question: "Send " + letter + "? This cannot be undone.", button: "Confirm: send " + letter };
}

export function receiptText(card: Card, answer: Answer): string {
  const head = "Got it: " + card.title.replace(/[?.!]+$/, "") + ", " + choiceText(answer.choice) + ", " + clockTime(answer.at);
  return answer.waitingOn ? head + ". Waiting on " + answer.waitingOn + "." : head;
}
