import type { World } from "../domain/types";
import { EXAMPLE_NOW } from "./example-content";

const CLOSED_AT = "2026-11-02T09:55:00-05:00";
const ASKED_AT = "2026-11-02T09:50:00-05:00";
const ROLLED_ASKED_AT = "2026-11-02T09:55:00-05:00";

export function rollOne(world: World, cardId: string): World {
  return {
    ...world,
    cards: world.cards.map((card) =>
      card.id === cardId
        ? { ...card, version: card.version + 1, changes: [...card.changes, { by: card.owner, at: EXAMPLE_NOW, following: "Say who checked it.", followingAt: ROLLED_ASKED_AT, what: "Added the Checked by line." }] }
        : card,
    ),
  };
}

export function closeOut(world: World, cardId: string): World {
  const card = world.cards.find((item) => item.id === cardId);
  if (!card) return world;
  return {
    ...world,
    cards: world.cards.filter((item) => item.id !== cardId),
    closed: [...(world.closed ?? []), { id: card.id, by: card.owner, at: CLOSED_AT, following: "drop it", followingAt: ASKED_AT }],
  };
}
