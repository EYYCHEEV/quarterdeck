import type { CardThread } from "./card";
import { CARD_EXAMPLE_NOW, exampleCardThreads as shortThreads } from "./example-cards-short";
import { CARD_TEXT } from "./example-cards-text";

export { CARD_EXAMPLE_NOW };

export function exampleCardThreads(): CardThread[] {
  return shortThreads().map((thread) => ({ ...thread, card: { ...thread.card, ...CARD_TEXT[thread.card.id] } }));
}
