import type { Tracker } from "../domain/tracker";
import type { Answer, CardEvidence, Choice, World } from "../domain/types";
import type { ChatApi } from "./chat-types";
import type { CaptainSecretsApi } from "./secret-types";

export class Refused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Refused";
  }
}

export class SignInRequired extends Error {
  constructor() {
    super("sign in again");
    this.name = "SignInRequired";
  }
}

export class SessionUnconfirmed extends Error {
  constructor() {
    super("the session could not be confirmed");
    this.name = "SessionUnconfirmed";
  }
}

export class LapsedWhileHidden extends SessionUnconfirmed {}

export class FreshSignInRequired extends Error {
  constructor() {
    super("a fresh sign-in is needed");
    this.name = "FreshSignInRequired";
  }
}

export class NotConfirmed extends Error {
  constructor() {
    super("the server may or may not have received it");
    this.name = "NotConfirmed";
  }
}

export class RateLimited extends Error {
  constructor() {
    super("too many requests, wait");
    this.name = "RateLimited";
  }
}

export type AnswerInput = { choice: Choice; note: string; version: number };

export type CommentInput = { text: string; requestId: string };

export type BotNote = { invitedBy: string; joined: string; active: string };

export type PendingJoin = { id: string; name: string; invitedBy: string; at: string; code: string; inviteId: string | null; endsAt?: string };

export type OpenInvite = { id: string; forName: string | null; by: string; ends: string; endsAt?: string };

export type MadeInvite = { invite: OpenInvite; code: string | null; prompt: string };

export type BotsNotice = { words: string; again: boolean };

export type JoinedBot = { id: string; name: string; role: string; at: string };

export type HistoryLine = { id: string; text: string; at: string };

export type CleanupDays = 30 | 60 | 90;

export type BotsAdmin = {
  notes: Record<string, BotNote>;
  pending: PendingJoin[];
  invites: OpenInvite[];
  joined: JoinedBot[];
  removed: Record<string, string>;
  history: HistoryLine[];
  password: boolean;
  pinned: Record<string, boolean>;
  cleanup: { on: boolean; days: CleanupDays };
  state: "loading" | "approval" | "failed" | "ready";
  approveHere: boolean;
  busy: boolean;
  notice: BotsNotice | null;
};

export type BotsApi = {
  current: () => BotsAdmin;
  subscribe: (onChange: () => void) => () => void;
  reload: () => Promise<void>;
  again: () => Promise<void>;
  clearNotice: () => void;
  createInvite: (name: string) => Promise<MadeInvite | null>;
  askLater: (inviteId: string) => void;
  cancelInvite: (inviteId: string) => Promise<void>;
  approveJoin: (joinId: string) => Promise<JoinedBot | null>;
  refuseJoin: (joinId: string) => Promise<void>;
  removeBot: (botId: string, name: string) => void;
  setPinned: (botId: string, pinned: boolean) => void;
  setPassword: (password: boolean) => void;
  setCleanup: (cleanup: BotsAdmin["cleanup"]) => void;
};

export type QdData = {
  now: () => number;
  loadedAt?: () => number;
  load: () => Promise<World>;
  watch: (onChange: (failure?: Error) => void) => () => void;
  openCard?: (cardId: string) => Promise<void>;
  closeCard?: (cardId: string) => void;
  limited?: () => boolean;
  openMailList?: () => Promise<void>;
  closeMailList?: () => void;
  openMailThread?: (ref: string) => Promise<void>;
  closeMailThread?: (ref: string) => void;
  comment?: (cardId: string, input: CommentInput) => Promise<void>;
  freshUntil?: () => number | null;
  signIn?: () => void;
  startSignIn?: () => void;
  answer: (cardId: string, input: AnswerInput) => Promise<Answer>;
  markSeen: (cardId: string) => void;
  markLooked: (laneId: string) => void;
  trackers: () => Promise<Record<string, Tracker>>;
  openPage: (file: string) => Promise<string>;
  publishPage: (ref: string, version: number) => Promise<void>;
  unpublishPage: (ref: string) => Promise<void>;
  evidence: (cardId: string) => Promise<CardEvidence | null>;
  chat: ChatApi;
  secrets: CaptainSecretsApi;
  signOut: () => Promise<void>;
  bots?: () => Promise<BotsApi>;
};
