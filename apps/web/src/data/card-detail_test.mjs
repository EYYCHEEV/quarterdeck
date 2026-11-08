import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import esbuild from "esbuild";
import { loadTs } from "../../tools/load-ts.mjs";
import { OPTION_FIELDS, SHORT_JSON, shortPartPlugin, TEXT_FIELDS } from "../../tools/short-part.mjs";

const DEFINE = { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true" };

async function bundle(contents, plugins = [], define = DEFINE) {
  const built = await esbuild.build({ stdin: { contents, resolveDir: "src/data", loader: "ts" }, bundle: true, write: false, format: "esm", define, loader: { ".html": "text" }, plugins });
  return built.outputFiles[0].text;
}

const load = async (contents, plugins) => import("data:text/javascript;base64," + Buffer.from(await bundle(contents, plugins)).toString("base64"));

const WORLD = 'export { createExampleData } from "./example-data"; export { withDetail } from "./card-detail";';
const full = await load(WORLD);
const short = await load(WORLD, [shortPartPlugin()]);

const base = { delay: 0, fail: new Set(), fixtures: "off", empty: false, chat: null, mail: null };
const VARIANTS = [
  ["the default example data", base],
  ["with the answered card", { ...base, answered: true }],
  ["after a roll-up", { ...base, changed: 1 }],
  ["with the test fixtures", { ...base, fixtures: "now" }],
  ["with the evidence fixtures", { ...base, fixtures: "evidence" }],
  ["with the Pages fixtures", { ...base, fixtures: "pages" }],
  ["with the Lane fixtures", { ...base, fixtures: "lanes" }],
  ["with the catch-up fixtures", { ...base, fixtures: "catch-up" }],
];

for (const [name, switches] of VARIANTS) {
  test(`${name}: every Task Card from the short part, passed through withDetail, equals today's card`, async () => {
    const today = await full.createExampleData(switches).load();
    const built = await short.createExampleData(switches).load();
    assert.deepEqual(built.cards.map(short.withDetail), today.cards);
    assert.deepEqual({ ...built, cards: [] }, { ...today, cards: [] });
  });
}

const cardsIn = (value, found = []) => {
  if (Array.isArray(value)) for (const item of value) cardsIn(item, found);
  else if (value && typeof value === "object") {
    if (value.card && typeof value.card === "object") found.push(value.card);
    for (const item of Object.values(value)) cardsIn(item, found);
  }
  return found;
};

const holdsNoText = (cards) => {
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.deepEqual(
      TEXT_FIELDS.filter((field) => field in card),
      [],
      card.id,
    );
    assert.deepEqual(card.options?.flatMap((option) => Object.keys(option).filter((key) => !OPTION_FIELDS.includes(key))) ?? [], [], card.id);
    assert.ok(card.context === undefined || card.context === "", card.id);
  }
};

for (const name of Object.keys(SHORT_JSON)) {
  test(`${name}: what the build ships holds no text field, no option text and no context, and keeps every card's title`, () => {
    const file = JSON.parse(fs.readFileSync("src/data/" + name, "utf8"));
    const shipped = SHORT_JSON[name](file);
    holdsNoText(cardsIn(shipped));
    assert.deepEqual(
      cardsIn(shipped).map((card) => card.title),
      cardsIn(file).map((card) => card.title),
    );
  });
}

test("example-cards-short.ts, the file the build reads in place of example-cards.ts, holds no text field, no option text and no context", async () => {
  const { exampleCardThreads } = await loadTs("src/data/example-cards-short.ts");
  holdsNoText(cardsIn(exampleCardThreads()));
});

test("the short part carries no card text: a wire card keeps its option labels and its title, and loses the option text, picture, context and skip line", async () => {
  const today = (await full.createExampleData(base).load()).cards.find((card) => card.id === "alba-1");
  const built = (await short.createExampleData(base).load()).cards.find((card) => card.id === "alba-1");
  assert.ok(today.options.length > 0 && today.options.every((option) => option.does) && today.ascii && today.more.context.length > 0 && today.skip);
  assert.deepEqual(
    built.options.map((option) => [option.letter, option.label, option.pick, option.door, option.does, option.cost, option.risk, option.pros, option.cons]),
    today.options.map((option) => [option.letter, option.label, option.pick, option.door, undefined, undefined, undefined, [], []]),
  );
  assert.deepEqual([built.ascii, built.more.context, built.skip, built.pickWhy, built.evidence, built.title, built.about], [null, [], null, null, [], today.title, today.about]);
});

test("the first load's bundle holds none of the Task Card text, and the full build holds it", async () => {
  const entry = 'export { createExampleData } from "./example-data";';
  const SENTENCES = [
    "A long group pushes the other groups off a phone screen.",
    "Marks the Lane Done. It stays as a read-only record.",
    "Anyone with the link can read and copy version 2 of this Page, without signing in.",
    " Settings > Appearance\\n ------------",
  ];
  const production = { ...DEFINE, __QD_FIXTURES__: "false" };
  const noText = await bundle(entry, [shortPartPlugin()], production);
  const withText = await bundle(entry, [], production);
  for (const sentence of SENTENCES) assert.deepEqual([sentence, noText.includes(sentence)], [sentence, false]);
  for (const sentence of SENTENCES) assert.deepEqual([sentence, withText.includes(sentence)], [sentence, true]);
});

test("withDetail gives the same object for the same card, and leaves a card it has no text for as it is", async () => {
  const world = await short.createExampleData(base).load();
  const first = world.cards.find((card) => card.id === "alba-1");
  assert.equal(short.withDetail(first), short.withDetail(first));
  const unknown = { ...first, id: "not-an-example-card" };
  assert.equal(short.withDetail(unknown), unknown);
  assert.equal(short.withDetail(null), null);
});

test("in a server build withDetail leaves a card as it is even when an example card has the same id, and the example build still adds the detail", async () => {
  const server = await import("data:text/javascript;base64," + Buffer.from(await bundle('export { withDetail } from "./card-detail";', [], { ...DEFINE, __QD_SOURCE__: '"server"' })).toString("base64"));
  const world = await short.createExampleData(base).load();
  const first = world.cards.find((card) => card.id === "alba-1");
  assert.equal(server.withDetail(first), first);
  assert.notEqual(short.withDetail(first), first);
});

test("the version times in the short part match the full version history, card by card", async () => {
  const today = await full.createExampleData(base).load();
  const built = await short.createExampleData(base).load();
  for (const card of today.cards) {
    const shortCard = built.cards.find((item) => item.id === card.id);
    assert.deepEqual(shortCard.versions.map((version) => [version.version, version.by, version.at, version.title, version.about]), card.versions.map((version) => [version.version, version.by, version.at, version.title, version.about]), card.id);
  }
});
