import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { BOTS } = await loadTs("src/data/example-content.ts");
const { avatarColor, avatarSlot } = await loadTs("src/domain/avatar.ts");

test("the example bots name their palette slots 1 to 5 in today's order, so their colours stay", () => {
  assert.deepEqual(
    BOTS.filter((bot) => !bot.removedAt).map((bot) => [bot.id, bot.color]),
    ["iris", "alba", "dr-kivo", "shelvorn", "dale"].map((id, at) => [id, avatarColor(at + 1)]),
  );
});

test("a bot with no named slot, Pib, takes the slot of its id", () => {
  assert.equal(BOTS.find((bot) => bot.id === "pib").color, avatarColor(avatarSlot("pib")));
});
