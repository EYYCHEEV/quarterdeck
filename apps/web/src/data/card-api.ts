import type { CardId, CardThread, Category, IsoWithOffset, Kind, Level, Pick, ThreadComment } from "./card";

export type CardSummary = {
  id: CardId;
  project: string;
  lane?: string;
  title: string;
  about: string;
  kind: Kind;
  category: Category[];
  due?: IsoWithOffset;
  rev: number;
  from: string;
  at: IsoWithOffset;
  commentCount: number;
  answer: { pick: Pick; rev: number } | null;
  priority?: Level;
  type?: string;
  unblocks: CardId[];
};

export type AnswerInput = { rev: number; pick: Pick; note?: string; comment?: string };

export type Receipt = { card: CardId; rev: number; pick: Pick; comment?: string; at: IsoWithOffset; older: boolean };

export type CardCall = "listCards" | "openCard" | "postAnswer" | "postComment";

export type CardApi = {
  listCards: () => Promise<CardSummary[]>;
  openCard: (cardId: CardId) => Promise<CardThread>;
  postAnswer: (cardId: CardId, input: AnswerInput) => Promise<Receipt>;
  postComment: (cardId: CardId, text: string) => Promise<ThreadComment>;
  watch: (onChange: () => void) => () => void;
};
