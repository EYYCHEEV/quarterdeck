import type { AnswerV1, CardThread, Option, ThreadComment } from "./card";
import type { AnswerInput, CardApi, CardCall, CardSummary, Receipt } from "./card-api";
import { CARD_EXAMPLE_NOW, exampleCardThreads } from "./example-cards";
import { Refused } from "./source";

export type StandInOptions = {
  latency?: () => number;
  clock?: () => string;
  fail?: (call: CardCall) => boolean;
  threads?: CardThread[];
};

const LETTERS = ["A", "B", "C", "D"];

const lettersOf = (options: Option[] | undefined) => (options ?? []).map((option) => option.label[0]);

function summarize(thread: CardThread): CardSummary {
  const { card } = thread;
  const given = thread.answers.filter((answer) => answer.comment === undefined).at(-1);
  return {
    id: card.id,
    project: card.project,
    lane: card.lane,
    title: card.title,
    about: card.about,
    kind: card.kind ?? "decision",
    category: [...card.category],
    due: card.due,
    rev: thread.rev,
    from: thread.from,
    at: thread.at,
    commentCount: thread.comments.length,
    answer: given ? { pick: given.pick, rev: given.rev } : null,
    priority: thread.priority,
    type: thread.type,
    unblocks: thread.unblocks ?? [],
  };
}

function receiptOf(answer: AnswerV1, thread: CardThread): Receipt {
  return {
    card: answer.card,
    rev: answer.rev,
    pick: answer.pick,
    ...(answer.comment === undefined ? {} : { comment: answer.comment }),
    at: answer.at,
    older: answer.rev < thread.rev,
  };
}

export type StandInCardApi = CardApi & { publish: (next: CardThread) => void };

export function createStandInCardApi(options: StandInOptions = {}): StandInCardApi {
  const latency = options.latency ?? (() => 150 + Math.random() * 650);
  const clock = options.clock ?? (() => CARD_EXAMPLE_NOW);
  let threads = options.threads ?? exampleCardThreads();
  const watchers = new Set<() => void>();

  const call = async <T>(name: CardCall, work: () => T): Promise<T> => {
    const wait = latency();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    if (options.fail?.(name)) throw new Error("the stand-in server could not be reached");
    return work();
  };

  const find = (cardId: string): CardThread => {
    const found = threads.find((thread) => thread.card.id === cardId);
    if (!found) throw new Refused("no such card");
    return found;
  };

  const replace = (next: CardThread) => {
    threads = threads.map((thread) => (thread.card.id === next.card.id ? next : thread));
    for (const watcher of [...watchers]) watcher();
  };

  return {
    publish: replace,
    listCards: () => call("listCards", () => threads.map(summarize)),
    openCard: (cardId) => call("openCard", () => find(cardId)),
    postAnswer: (cardId, input: AnswerInput) =>
      call("postAnswer", () => {
        const thread = find(cardId);
        if (!Number.isInteger(input.rev) || input.rev < 1 || input.rev > thread.rev) throw new Refused("that revision does not exist");
        const small = input.comment === undefined ? null : (thread.comments.find((item) => item.body.id === input.comment)?.body ?? null);
        if (input.comment !== undefined && !small?.options) throw new Refused("that comment has no options to pick on");
        if (!small && thread.card.kind === "fyi") throw new Refused("an FYI card has no buttons");
        const older = input.rev < thread.rev;
        const extra = input.pick === "cant-decide" || input.pick === "none";
        const onCard = LETTERS.includes(input.pick) && (older || lettersOf(small ? small.options : thread.card.options).includes(input.pick));
        if (!extra && !onCard) throw new Refused("that pick is not on this card");
        const same = thread.answers.find((answer) => answer.comment === input.comment && answer.rev === input.rev && answer.pick === input.pick);
        if (same) return receiptOf(same, thread);
        const answer: AnswerV1 = {
          qd: "answer/1",
          card: cardId,
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          rev: input.rev,
          pick: input.pick,
          ...(input.note ? { note: input.note } : {}),
          at: clock(),
        };
        replace({ ...thread, answers: thread.answers.concat(answer) });
        return receiptOf(answer, thread);
      }),
    postComment: (cardId, text) =>
      call("postComment", () => {
        const thread = find(cardId);
        const words = text.trim();
        if (!words) throw new Refused("a comment needs words");
        const item: ThreadComment = { from: "Captain", at: clock(), body: { qd: "comment/1", card: cardId, text: words } };
        replace({ ...thread, comments: thread.comments.concat(item) });
        return item;
      }),
    watch: (onChange) => {
      watchers.add(onChange);
      return () => {
        watchers.delete(onChange);
      };
    },
  };
}
