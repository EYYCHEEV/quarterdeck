import type { Card, CardOption, Door } from "../domain/types";
import type { CardEvent, CardRead } from "./api-client";
import type { Option } from "./card";

type Answered = Extract<CardEvent, { kind: "answer" }>;

const LETTERS = "ABCDEFGH";

const doorOf = (door: string | undefined): Door | undefined => (door === "one-way" || door === "two-way" ? door : undefined);

function optionsOf(options: Option[] | undefined, cardDoor: string | undefined): CardOption[] {
  return (options ?? []).map((option, at) => {
    const lettered = /^([A-Z])\.\s*(.*)$/.exec(option.label);
    const pick = option.pick === true;
    return {
      letter: lettered ? lettered[1] : LETTERS[at],
      label: lettered ? lettered[2] : option.label,
      pick,
      door: (pick ? doorOf(cardDoor) : undefined) ?? "two-way",
      does: option.does,
      cost: option.cost,
      risk: option.risk,
      undo: option.undo,
      pros: option.pros ?? [],
      cons: option.cons ?? [],
      tradeoff: option.tradeoff,
      why: option.why,
    };
  });
}

const isFinalAnswer = (rev: number) => (event: CardEvent): event is Answered => event.kind === "answer" && !event.forComment && event.rev === rev;

export function detailOf(read: CardRead, base: Card): Card {
  const { card, rev, thread } = read;
  const final = thread.filter(isFinalAnswer(rev)).at(-1);
  return {
    ...base,
    version: rev,
    title: card.title,
    owner: base.owner || (thread.find((event) => event.kind === "card")?.sender ?? ""),
    due: card.due ?? null,
    about: card.about,
    ascii: card.ascii ?? null,
    skip: card.skip ?? null,
    options: optionsOf(card.options, card.door),
    pickWhy: card.pick_why ?? null,
    approvalDoor: doorOf(card.door) ?? "two-way",
    labels: [...new Set(card.category)],
    evidence: [],
    media: [],
    commands: card.commands ?? [],
    answer: base.answer && final ? { ...base.answer, note: final.note ?? "" } : base.answer,
    more: { context: card.context.split("\n").filter(Boolean), words: card.words ?? [], learn: card.learn ?? [], note: card.note ?? null },
  };
}
