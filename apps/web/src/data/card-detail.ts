import type { Card } from "../domain/types";
import { answeredOutcome as cardOutcomes, cards, currentFixes, versions } from "./card-content.json";
import { exampleCardThreads } from "./example-cards";
import { ANSWERED_EXTRA, SHORT_CARDS } from "./example-content";
import { threadSources, type SourceCard } from "./lanes";
import { answeredOutcome, newTaskCards } from "./lanes-addendum.json";
import { pageCardThreads, type PageCard } from "./pages";
import { taskCardsAdd } from "./pages.json";
import { buildCards, type Content } from "./world";

const CONTENT = { cards, currentFixes, versions, answeredOutcome: { ...cardOutcomes, ...answeredOutcome } } as unknown as Content;
const NO_SESSION = { seen: new Map(), answers: new Map(), looked: new Map() };

let whole: Map<string, Card> | null = null;
const given = new WeakMap<Card, Card>();

function allCards(): Map<string, Card> {
  if (!whole) {
    const signOffs = threadSources((newTaskCards as unknown as SourceCard[]).map((taskCard) => ({ taskCard })));
    const threads = [...exampleCardThreads(), ...pageCardThreads(taskCardsAdd as unknown as PageCard[]), ...signOffs.threads];
    whole = new Map(buildCards({ threads, extras: signOffs.extras, short: [...SHORT_CARDS, ANSWERED_EXTRA], session: NO_SESSION }, CONTENT).map((card) => [card.id, card]));
  }
  return whole;
}

export function withDetail(card: Card | null): Card | null {
  if (!card || (typeof __QD_SOURCE__ !== "undefined" && __QD_SOURCE__ === "server")) return card;
  const known = given.get(card);
  if (known) return known;
  const source = allCards().get(card.id);
  if (!source) return card;
  const { ascii, skip, options, pickWhy, evidence, media, commands, more, versions: history } = source;
  const result = { ...card, ascii, skip, options, pickWhy, evidence, media, commands, more, versions: history };
  given.set(card, result);
  return result;
}
