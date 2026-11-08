export type Category = "design" | "strategy" | "high-risk" | "try-it" | "your-hands";
export type Kind = "decision" | "action" | "fyi";
export type Door = "one-way" | "two-way";
export type Letter = "A" | "B" | "C" | "D";
export type Pick = Letter | "cant-decide" | "none";
export type Level = "P0" | "P1" | "P2" | "P3" | "P4";

export type CardId = string;
export type IsoWithOffset = string;

export interface Option {
  label: string;
  pick?: boolean;
  does?: string;
  cost?: string;
  risk?: string;
  undo?: string;
  pros?: string[];
  cons?: string[];
  tradeoff?: string;
  why?: string;
  door?: Door;
}

export interface Command {
  where: string;
  run: string;
}

export interface LearnLink {
  label: string;
  url: string;
}

export interface Principles {
  follows: string;
  departs: string;
}

export type Word = [term: string, meaning: string];

export interface CardFields {
  id: CardId;
  project: string;
  lane?: string;
  title: string;
  about: string;
  context: string;
  ascii?: string;
  options?: Option[];
  pick_why?: string;
  you_do?: string;
  skip?: string;
  due?: IsoWithOffset;
  door?: Door;
  undo?: string;
  category: [Category] | [Category, Category];
  kind?: Kind;
  words?: Word[];
  learn?: LearnLink[];
  commands?: Command[];
  principles?: Principles;
  note?: string;
  mailRef?: string;
  pageRefs?: string[];
  artifactRefs?: string[];
  media?: { kind: string; file: string; caption: string }[];
}

export interface CardV1 extends CardFields {
  qd: "card/1";
  card: CardId;
}

export type ChangedFields = { [K in Exclude<keyof CardFields, "id" | "project">]?: CardFields[K] | null };

export interface UpdateV1 extends ChangedFields {
  qd: "update/1";
  card: CardId;
  rev: number;
}

export interface WithdrawV1 {
  qd: "withdraw/1";
  card: CardId;
  why: string;
}

export interface CommentV1 {
  qd: "comment/1";
  card: CardId;
  id?: string;
  text: string;
  options?: Option[];
  pick_why?: string;
}

export interface AnswerV1 {
  qd: "answer/1";
  card: CardId;
  comment?: string;
  rev: number;
  pick: Pick;
  note?: string;
  at: IsoWithOffset;
}

export type CardMailBody = CardV1 | UpdateV1 | WithdrawV1 | CommentV1 | AnswerV1;

export type CardMail =
  | { subject: `CARD: ${string}`; body: CardV1 }
  | { subject: `UPDATE: ${CardId}`; body: UpdateV1 }
  | { subject: `WITHDRAW: ${CardId}`; body: WithdrawV1 }
  | { subject: `COMMENT: ${CardId}`; body: CommentV1 }
  | { subject: `ANSWER: ${CardId} ${Pick}`; body: AnswerV1 };

export const BUDGET = {
  title: 70,
  about: 200,
  context_lines: 3,
  options_min: 2,
  options_max: 4,
  label: 120,
  pick_why: 300,
  you_do: 400,
  skip: 300,
  art_lines: 8,
  art_cols: 44,
  command_blocks: 12,
  note_art_cols: 60,
  withdraw_why: 300,
} as const;

export const MAX_BODY_BYTES = 65536;

export type ThreadComment = { from: string; at: IsoWithOffset; body: CommentV1 };

export type CardThread = {
  card: CardV1;
  rev: number;
  from: string;
  at: IsoWithOffset;
  priority?: Level;
  type?: string;
  unblocks?: CardId[];
  comments: ThreadComment[];
  answers: AnswerV1[];
};
