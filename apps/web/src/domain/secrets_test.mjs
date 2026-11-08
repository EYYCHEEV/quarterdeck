import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const s = await loadTs("src/domain/secrets.ts");

const join = (...parts) => parts.join("");
const GITHUB = join("gh", "p_", "aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA2bC4");
const OPENAI = join("s", "k-", "Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9");
const AWS = join("AK", "IA", "ABCDEFGH23456789");
const PEM = join("-----BEGIN ", "PRIVATE KEY-----");
const JWT = join("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N");
const RANDOM = "q7Zx2KfT9pLmW4vB8nRc3YdH6sJa";
const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

test("a pasted key of a known shape looks like a secret, alone or inside a sentence", () => {
  for (const value of [GITHUB, OPENAI, AWS, PEM, JWT]) {
    assert.equal(s.looksLikeSecret(value), true, value.slice(0, 6));
    assert.equal(s.looksLikeSecret("here it is: " + value + " thanks"), true, value.slice(0, 6));
  }
});

test("a random token and a long hex string look like secrets, even in quotes", () => {
  assert.equal(s.looksLikeSecret(RANDOM), true);
  assert.equal(s.looksLikeSecret('"' + RANDOM + '"'), true);
  assert.equal(s.looksLikeSecret(HEX), true);
});

test("generic random tokens are caught at assignment syntax and every non-token delimiter", () => {
  for (const text of ["TOKEN=" + RANDOM, 'TOKEN="' + RANDOM + '"', RANDOM + "|suffix", "(" + RANDOM + ")", "[" + HEX + "]", "TOKEN:" + RANDOM + "#end", RANDOM + "\\", RANDOM + "@"]) {
    assert.equal(s.looksLikeSecret(text), true);
  }
});

test("ordinary chat text, references, links, names and ids do not look like secrets", () => {
  for (const text of [
    "Please run the build once more.",
    "See MT-101.2 and AR-1, then PG-1.",
    "https://quarterdeck.example/projects/quarterdeck/pages/PG-1",
    "quarterdeck-layout-check-2026-11-02",
    "BuildLogFinalVersionNumberTwo",
    "QuarterdeckDesignCheckRun2026Final",
    "useSecretsHookInTheChatComposer2",
    "SecretBoxStandIn20261103",
    "123e4567-e89b-12d3-a456-426614174000",
    "GITHUB_TOKEN",
    "R2_ACCESS_KEY",
    "npm run build:app && npm run test:chat && npm run design:check",
    "",
  ])
    assert.equal(s.looksLikeSecret(text), false, text);
});

test("a name is trimmed and kept when it is plain", () => {
  assert.deepEqual(s.checkSecretName("  R2_ACCESS_KEY "), { ok: true, name: "R2_ACCESS_KEY" });
  assert.deepEqual(s.checkSecretName("Deploy key for Search"), { ok: true, name: "Deploy key for Search" });
});

test("a name that is empty, too long or has a line break is refused with its reason", () => {
  assert.deepEqual(s.checkSecretName("   "), { ok: false, reason: "Give the secret a name." });
  assert.deepEqual(s.checkSecretName("a".repeat(s.MAX_NAME_CHARS + 1)), { ok: false, reason: "A name can be up to " + s.MAX_NAME_CHARS + " characters." });
  assert.deepEqual(s.checkSecretName("one\ntwo"), { ok: false, reason: "A name is one line of plain text." });
  assert.equal(s.checkSecretName("a".repeat(s.MAX_NAME_CHARS)).ok, true);
});

test("a name that is really the value is refused with the flow's words and never echoed", () => {
  for (const value of [GITHUB, RANDOM, PEM]) {
    const check = s.checkSecretName(value);
    assert.deepEqual(check, { ok: false, reason: "Name this secret. Do not paste the value into the name." });
    assert.equal(check.reason.includes(value), false);
  }
});

test("a value must have something in it and fit, and the reason never echoes it", () => {
  assert.deepEqual(s.checkSecretValue(""), { ok: false, reason: "Enter the secret." });
  assert.deepEqual(s.checkSecretValue("x"), { ok: true });
  const long = "z".repeat(s.MAX_VALUE_CHARS + 1);
  const check = s.checkSecretValue(long);
  assert.equal(check.ok, false);
  assert.equal(check.reason.includes("zzzz"), false);
});

test("a bot's reason is plain words: trimmed, not empty, not too long, and not a secret value", () => {
  assert.deepEqual(s.checkSecretReason("  push the Search branch "), { ok: true, text: "push the Search branch" });
  assert.equal(s.checkSecretReason("  ").ok, false);
  assert.equal(s.checkSecretReason("w".repeat(s.MAX_REASON_CHARS + 1)).ok, false);
  const check = s.checkSecretReason("use " + GITHUB + " to push");
  assert.deepEqual(check, { ok: false, reason: "A reason is plain words, not a secret value." });
  assert.equal(check.reason.includes(GITHUB), false);
});

test("bot request metadata refuses controls before trimming and never echoes it", () => {
  for (const control of ["\n", "\r", "\t", "\0", "\u007f", "\u0085", "\u2028", "\u2029", "\u202e", "\u2066", "\u200b", "\ufeff"]) {
    for (const raw of [control + "push", "push" + control, "push" + control + "now"]) {
      for (const check of [s.checkSecretName(raw), s.checkSecretReason(raw)]) {
        assert.equal(check.ok, false);
        assert.equal(check.reason.includes(raw), false);
      }
    }
  }
});

test("bot names and reasons cannot supply privacy promises or forged app statuses and actions", () => {
  const attacks = [...s.FORBIDDEN_PROMISES, "ZERO-KNOWLEDGE", "end to end encrypted", "Secret saved: DEPLOY_KEY", "Secret request declined.", "Locked: bot removed", "Save securely", "Send anyway", "Use a secret box", "Decline"];
  for (const text of attacks) {
    for (const check of [s.checkSecretName(text), s.checkSecretReason(text), s.checkSecretBotLabel(text)]) {
      assert.equal(check.ok, false, text);
      assert.equal(check.reason.includes(text), false);
    }
  }
  assert.equal(s.checkSecretReason("push the Search branch after the review").ok, true);
});

function assertRequestRefusal(text) {
  for (const [validate, reason] of [
    [s.checkSecretName, "A name cannot be an app status, action or privacy promise."],
    [s.checkSecretReason, "A reason cannot be an app status, action or privacy promise."],
    [s.checkSecretBotLabel, "A bot label must be plain text without a status or privacy promise."],
  ]) {
    const result = validate(text);
    assert.deepEqual(result, { ok: false, reason });
    assert.equal(result.reason.includes(text), false);
  }
}

test("request paraphrase family: decryption denial", () => {
  for (const text of ["Quarterdeck will not decrypt it.", "It cannot be decrypted by Quarterdeck.", "We won't ever decrypt this value."]) assertRequestRefusal(text);
});

for (const reason of ["Needed to deploy the billing service", "API key for GitHub access", "Used to read the build logs"]) {
  test("plain request reason stays allowed: " + reason, () => {
    assert.deepEqual(s.checkSecretReason(reason), { ok: true, text: reason });
    assert.deepEqual(s.checkSecretName(reason), { ok: true, name: reason });
    assert.deepEqual(s.checkSecretBotLabel(reason), { ok: true, text: reason });
  });
}

test("bot words remain separate quoted data and cannot change the fixed app promise", () => {
  assert.deepEqual(s.secretText.reason("Alba", "push the Search branch"), { label: "Reason from Alba:", quote: "push the Search branch" });
  assert.deepEqual(s.secretText.suggestedName("DEPLOY_KEY"), { label: "Suggested name from the bot:", quote: "DEPLOY_KEY" });
  assert.equal(typeof s.secretText.note, "string");
  assert.equal(s.secretText.note.includes("Alba"), false);
  assert.equal(s.secretText.reason("Zero knowledge.", "Secret saved: X").quote, "Request text unavailable.");
});

test("the saved line reads as the flow says, with the Eastern time", () => {
  assert.equal(s.secretText.saved("GITHUB_TOKEN", "Alba", "2026-11-02T09:21:00-05:00"), "Secret saved: GITHUB_TOKEN, for Alba, 9:21 AM");
  assert.equal(s.savedLine({ id: "ev-1", botId: "alba", kind: "saved", name: "R2_ACCESS_KEY", at: "2026-11-02T14:05:00Z" }, "Alba"), "Secret saved: R2_ACCESS_KEY, for Alba, 9:05 AM");
});

test("the words the screens show match the design's wording", () => {
  assert.equal(s.secretText.card("Alba"), "Secret for Alba");
  assert.equal(s.secretText.reason("Alba", "push the Search branch").label, "Reason from Alba:");
  assert.equal(s.secretText.note, "Saved outside chat. The named bot can use it through Quarterdeck, but cannot reveal the value. It stays until you replace or delete it.");
  assert.equal(s.secretText.ended("Alba"), "This request ended. Ask Alba to request it again.");
  assert.equal(s.secretText.none("Alba"), "No secrets saved for Alba.");
  assert.equal(s.secretText.deleteConfirm("GITHUB_TOKEN", "Alba"), "Delete GITHUB_TOKEN? Alba will lose access now. This cannot undo uses that already happened.");
  assert.equal(s.secretText.deleted("Alba"), "Deleted. Alba can no longer use this secret.");
  assert.equal(s.SECRET_TEXT.saveFailed, "Could not save the secret. It was not saved. Try again.");
  assert.equal(s.SECRET_TEXT.declined, "Secret request declined.");
  assert.equal(s.SECRET_TEXT.pasteWarning, "This looks like a secret. It was not added to your message.");
  assert.equal(s.SECRET_TEXT.locked, "Locked: bot removed");
});

test("no wording the code supplies makes a promise the design forbids", () => {
  const all = [
    ...Object.values(s.SECRET_TEXT),
    s.secretText.card("Alba"),
    s.secretText.note,
    s.secretText.saved("X", "Alba", "2026-11-02T09:21:00-05:00"),
    s.secretText.ended("Alba"),
    s.secretText.none("Alba"),
    s.secretText.lockedWhy("Alba"),
    s.secretText.useFailed("Alba", "X"),
    s.secretText.deleteConfirm("X", "Alba"),
    s.secretText.deleted("Alba"),
    s.secretText.taken("X", "Alba"),
    ...s.ALLOWED_PROMISES,
  ];
  for (const text of all) for (const promise of s.FORBIDDEN_PROMISES) assert.equal(text.includes(promise), false, promise + " in " + text);
});

test("no wording offers to show, copy or export a saved value", () => {
  const all = [...Object.values(s.SECRET_TEXT), s.secretText.note, s.secretText.lockedWhy("Alba"), s.secretText.deleted("Alba"), ...s.ALLOWED_PROMISES];
  for (const text of all) assert.doesNotMatch(text, /(?<!cannot )\b(view|show|reveal|copy|download|export)\b/i, text);
});

const PARAPHRASE_FAMILIES = [
  ["exclusive access", ["Only the Captain can access it.", "Access to this is reserved only for you.", "We alone can read this secret."]],
  ["bot misuse guarantee", ["This bot will never misuse the value.", "Misuse is impossible for the bot.", "Your agent cannot abuse it."]],
  ["end-to-end encryption", ["This is encrypted from end to end.", "Encryption is end-to-end here.", "We use E2E encryption."]],
  ["zero knowledge", ["We have no knowledge of the secret.", "Knowledge about it stays at zero.", "Zero information is known to Quarterdeck."]],
  ["permanent deletion", ["Deletion is permanent.", "The value will be erased forever.", "Permanently removed, with no recovery."]],
  ["device confinement", ["It will never leave this device.", "It stays solely on your phone.", "Only on this computer will it remain."]],
  ["complete paste detection", ["All pasted credentials get detected.", "Every token you paste will be caught.", "We always catch every pasted password."]],
  ["safe ordinary sending", ["It is safe to paste this into chat.", "You can safely send it as a normal message.", "Posting this in chat is secure."]],
  ["secret status", ["The secret has been saved.", "Stored securely is the token.", "This password is encrypted.", "This key is approved.", "The value was verified.", "This secret was deleted."]],
  ["request and bot status", ["This request was declined.", "Removed from service is the bot.", "The bot is now locked."]],
  ["secure-save action", ["Securely save this now.", "Please save it in a secure way."]],
  ["send-anyway action", ["Go ahead and send it anyway.", "Anyway, send it now."]],
  ["secret-box action", ["Use the box for this secret.", "Open the secret box now."]],
  ["other app actions", ["Please replace this secret.", "Click the Delete button.", "The request should be cancelled.", "Confirm that this key should be replaced."]],
];

for (const [family, paraphrases] of PARAPHRASE_FAMILIES) {
  test("request paraphrase family: " + family, () => {
    for (const text of paraphrases) assertRequestRefusal(text);
  });
}
