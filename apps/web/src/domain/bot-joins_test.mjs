import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { BOTS_WORDS } = await loadTs("src/domain/bot-joins.ts");

test("the Bots lines send the Captain to Backchannel, word for word", () => {
  assert.deepEqual([BOTS_WORDS.approve, BOTS_WORDS.history, BOTS_WORDS.waiting], ["Approve in Backchannel for now.", "Joins history is in Backchannel for now.", "Approve it in Backchannel when it asks."]);
});

test("when approving happens here, Add bot's waiting line points to Pending joins, word for word", () => {
  assert.equal(BOTS_WORDS.waitingHere, "Invite copied. When it asks, approve it under Pending joins.");
});
