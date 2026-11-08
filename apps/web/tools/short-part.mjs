import fs from "node:fs";
import path from "node:path";

export const TEXT_FIELDS = ["ascii", "pick_why", "you_do", "skip", "words", "learn", "commands", "principles", "note", "mailRef", "pageRefs", "artifactRefs", "media"];
export const OPTION_FIELDS = ["label", "pick", "door"];

const FILES = /(?:^|\/)(?:(?:card-content|lanes-addendum|pages)\.json(?:\?short)?|example-cards)$/;
const FULL_READER = /\/data\/card-detail\.ts$/;
const SHORT = "?short";

export function shortPart(value) {
  if (Array.isArray(value)) return value.map(shortPart);
  if (!value || typeof value !== "object") return value;
  const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortPart(item)]));
  if (out.card && typeof out.card === "object") {
    const kept = Object.fromEntries(Object.entries(out.card).filter(([key]) => !TEXT_FIELDS.includes(key)));
    if (kept.options) kept.options = kept.options.map((option) => Object.fromEntries(Object.entries(option).filter(([key]) => OPTION_FIELDS.includes(key))));
    out.card = "context" in kept ? { ...kept, context: "" } : kept;
  }
  return out;
}

export const SHORT_JSON = {
  "card-content.json": (file) => ({
    ...file,
    currentFixes: {},
    cards: Object.fromEntries(Object.entries(file.cards).map(([id, item]) => [id, item.about === undefined ? {} : { about: item.about }])),
    versions: shortPart(file.versions),
  }),
  "lanes-addendum.json": (file) => ({ ...file, newTaskCards: shortPart(file.newTaskCards) }),
  "pages.json": (file) => ({ ...file, taskCardsAdd: shortPart(file.taskCardsAdd) }),
};

export const shortPartPlugin = () => ({
  name: "short-part",
  setup(build) {
    build.onResolve({ filter: FILES }, (args) => {
      const marked = args.path.endsWith(SHORT);
      if (!marked && FULL_READER.test(args.importer)) return undefined;
      const file = path.resolve(args.resolveDir, marked ? args.path.slice(0, -SHORT.length) : args.path);
      return file.endsWith("example-cards") ? { path: file + "-short.ts" } : { path: file, suffix: SHORT };
    });
    build.onLoad({ filter: /\.json$/ }, (args) => (args.suffix === SHORT ? { contents: JSON.stringify(SHORT_JSON[path.basename(args.path)](JSON.parse(fs.readFileSync(args.path, "utf8")))), loader: "json" } : undefined));
  },
});
