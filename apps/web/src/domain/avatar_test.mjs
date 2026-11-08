import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { avatarColor, avatarSlot, AVATAR_SLOTS } = await loadTs("src/domain/avatar.ts");

test("a bot with no named slot gets the same slot from its id on every call", () => {
  assert.equal(avatarSlot("new-bot-7"), avatarSlot("new-bot-7"));
});

test("every id gets a slot from 1 to the palette size", () => {
  const slots = ["iris", "pib", "new-bot-7", "x", "a-much-longer-bot-id-with-dashes"].map(avatarSlot);
  assert.equal(slots.every((slot) => Number.isInteger(slot) && slot >= 1 && slot <= AVATAR_SLOTS), true);
});

test("a slot names a palette colour, never a colour value", () => {
  assert.equal(avatarColor(3), "var(--color-avatar-3)");
});
