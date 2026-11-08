import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { parseReference, linkParts } = await loadTs("src/domain/references.ts");

test("references parse into mail threads, single mails, Pages and Artifacts", () => {
  assert.deepEqual(parseReference("MT-101"), { kind: "mail", code: "MT-101", thread: "MT-101" });
  assert.deepEqual(parseReference("MT-101.2"), { kind: "mail", code: "MT-101.2", thread: "MT-101" });
  assert.deepEqual(parseReference("PG-1"), { kind: "page", code: "PG-1" });
  assert.deepEqual(parseReference("AR-12"), { kind: "artifact", code: "AR-12" });
});

test("anything else is not a reference", () => {
  for (const text of ["c1", "MT-", "MT-101.", "pg-1", "AR-1x", " PG-1", ""]) assert.equal(parseReference(text), null, text);
});

test("text splits into plain words, references and known card numbers", () => {
  const parts = linkParts("Pick A on c1, see MT-101.2 and PG-1; c99 is not a card.", new Set(["c1"]));
  assert.deepEqual(parts, [
    { kind: "text", text: "Pick A on " },
    { kind: "card", text: "c1" },
    { kind: "text", text: ", see " },
    { kind: "ref", text: "MT-101.2" },
    { kind: "text", text: " and " },
    { kind: "ref", text: "PG-1" },
    { kind: "text", text: "; c99 is not a card." },
  ]);
});
