import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = ["src", "public"];
const THEME_NAME = "src/ui/theme.css";
const KNOWN_NAME = "tools/lint/raw-values-known.json";
const CODE = /^src\/(?:ui|screens|shell)\/.*\.tsx?$/;
const SHEET = /\.css$/;
const WORD = /[^\s"'`]+/g;
const BRACKET_CLASS = /^-?[a-z][a-z0-9-]*-\[[^\]]*\]$/;
const RAW_UNIT = /(?<![A-Za-z0-9])\d*\.?\d+(?:px|rem|em|ms|s)\b/;
const NUMBER_SCALE = /^-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|w|h|size|min-w|min-h|max-w|max-h|basis|scroll-m[xytrblse]?|scroll-p[xytrblse]?|leading)-(\d+(?:\.\d+)?|px)$/;
const NAME_SCALES = [
  /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/,
  /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/,
  /^rounded(?:-[trblse]{1,2})?(?:-(?:xs|sm|md|lg|xl|[2-4]xl|full))?$/,
  /^leading-(?:normal|relaxed|loose)$/,
  /^tracking-(?:tighter|tight|normal|wide|wider|widest)$/,
  /^shadow-(?:2xs|xs|sm|md|lg|xl|2xl)$/,
];
const OLD_THEME = [
  /^text-(?:caps|tag|picture|small|code|note|prose|row|card|title-lg|screen|screen-wide|initial-(?:xs|sm|xl))$/,
  /^rounded(?:-[trblse]{1,2})?-(?:tile|small|control|card)$/,
  /^(?:shadow-pop|brass-fill)$/,
];
const PAINTS = "(?:bg|text|border(?:-[trblxyse])?|outline|ring|fill|stroke|decoration|divide|placeholder|caret|accent|shadow|from|via|to)";
const DROPPED_COLOUR = new RegExp("^" + PAINTS + "-(?:brass|red|green|blue|violet|link|frost|bubble|hover|you|p0|p1|avatar|chat|code-ink|picture-ink|line-2|lanes-edge)(?:-[a-z0-9-]+)?(?:\\/\\d+)?$");
const SEE_THROUGH = new RegExp("^" + PAINTS + "-[a-z][a-z0-9-]*\\/\\d+$");
const COLOUR_MATH = /color-mix\(/g;
const STYLE_OPEN = /style=\{\{/;
const STYLE_STRING = /["'`][^"'`]*?(?<![\w.])\d*\.?\d+(?:px|rem|em)\b/;
const STYLE_NUMBER = /\b(?:width|height|minWidth|minHeight|maxWidth|maxHeight|top|right|bottom|left|inset\w*|gap|rowGap|columnGap|padding\w*|margin\w*|fontSize|borderRadius|borderWidth|outlineOffset|letterSpacing)\s*:\s*-?(\d+(?:\.\d+)?)\s*(?=[,}]|$)/g;
const CONDITION = /^@(?:media|container)\b/;
const SHEET_RULES = [
  [/#[0-9a-fA-F]{3,8}\b/g, "is a colour written in place; read a colour of the theme"],
  [/\b(?:rgba?|hsla?)\(/g, "is a colour written in place; read a colour of the theme"],
  [/(?<![\w.#])\d*\.?\d+(?:px|rem|em)\b/g, "is a raw length; read a step of the theme"],
  [/(?<![\w.#])\d*\.?\d+(?:ms|s)\b/g, "is a raw time; read a time of the theme"],
  [COLOUR_MATH, "is colour math; only the theme mixes a colour"],
];

function parts(word) {
  let depth = 0;
  let cut = 0;
  for (let at = 0; at < word.length; at++) {
    const ch = word[at];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) cut = at + 1;
  }
  return word.slice(cut).replace(/^!|!$/g, "");
}

function classProblem(base, known, used) {
  if (BRACKET_CLASS.test(base) && RAW_UNIT.test(base.slice(base.indexOf("[")))) {
    if (Object.hasOwn(known, base)) {
      used.add(base);
      return null;
    }
    return "is a raw length or time in a class; use a step of the design";
  }
  const number = NUMBER_SCALE.exec(base);
  if (number && number[1] !== "0") return "is from Tailwind's number scale, which the theme switches off, so it builds nothing; use a step of the design";
  if (NAME_SCALES.some((rule) => rule.test(base))) return "is from one of Tailwind's own name scales, which the theme switches off, so it builds nothing; use a step of the design";
  if (OLD_THEME.some((rule) => rule.test(base))) return "is a name of the old theme, so it builds nothing; use a step of the design";
  if (DROPPED_COLOUR.test(base)) return "names a colour the design drops, so it builds nothing; use a colour of the design";
  if (SEE_THROUGH.test(base)) return "is a see-through step on a colour; use a solid colour of the design";
  return null;
}

function styleProblem(text) {
  const string = STYLE_STRING.exec(text);
  if (string) return string[0].slice(1) + " is a raw length in a style prop; read a step of the theme";
  for (const match of text.matchAll(STYLE_NUMBER)) {
    if (Number(match[1]) !== 0) return match[0].trim() + " is a raw length in a style prop; read a step of the theme";
  }
  return null;
}

function codeProblems(name, text, known, used) {
  const found = [];
  let inStyle = false;
  text.split("\n").forEach((line, at) => {
    const say = (what) => found.push(`${name}:${at + 1}: ${what}`);
    for (const match of line.matchAll(WORD)) {
      const problem = classProblem(parts(match[0]), known, used);
      if (problem) say(match[0] + " " + problem);
    }
    for (const match of line.matchAll(COLOUR_MATH)) say(match[0] + " is colour math; only the theme mixes a colour");
    const open = STYLE_OPEN.exec(line);
    if (open || inStyle) {
      const from = open ? open.index + open[0].length : 0;
      const close = line.indexOf("}}", from);
      const problem = styleProblem(close < 0 ? line.slice(from) : line.slice(from, close + 1));
      if (problem) say(problem);
      inStyle = close < 0;
    }
  });
  return found;
}

const LENGTH_RULE = SHEET_RULES[2][0];
const SIZE_OR_PLACE = /^(?:(?:min-|max-)?(?:width|height)|grid-template-(?:columns|rows)|flex-basis|top|right|bottom|left|inset(?:-[a-z-]+)?|scroll-margin(?:-[a-z-]+)?|scroll-padding(?:-[a-z-]+)?)$/;

function propertyAt(line, index) {
  const start = Math.max(line.lastIndexOf(";", index), line.lastIndexOf("{", index)) + 1;
  return line.slice(start, index).split(":")[0].trim();
}

function sheetProblems(name, text, oldLayout, used) {
  const found = [];
  text.split("\n").forEach((line, at) => {
    if (CONDITION.test(line.trim())) return;
    for (const [rule, what] of SHEET_RULES) {
      for (const match of line.matchAll(rule)) {
        if (oldLayout && rule === LENGTH_RULE && SIZE_OR_PLACE.test(propertyAt(line, match.index))) used.add(name);
        else found.push(`${name}:${at + 1}: ${match[0]} ${what}`);
      }
    }
  });
  return found;
}

export function rawValueProblems(files, known = {}) {
  const used = new Set();
  const found = [];
  for (const { name, text } of files) {
    if (CODE.test(name) && !name.endsWith(".d.ts")) found.push(...codeProblems(name, text, known, used));
    else if (SHEET.test(name) && name !== THEME_NAME) found.push(...sheetProblems(name, text, Object.hasOwn(known, name), used));
  }
  for (const listed of Object.keys(known)) {
    if (!used.has(listed)) found.push(`${KNOWN_NAME}: ${listed} is listed but nothing uses it any more; take it off the list`);
  }
  return found;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(?:tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = ROOTS.flatMap(walk).map((file) => ({ name: file.split(path.sep).join("/"), text: fs.readFileSync(file, "utf8") }));
  const known = fs.existsSync(KNOWN_NAME) ? JSON.parse(fs.readFileSync(KNOWN_NAME, "utf8")) : {};
  const problems = rawValueProblems(files, known);
  if (problems.length) {
    for (const problem of problems) console.log(problem);
    console.log(`raw-values: FAIL, ${problems.length} raw values or switched-off names`);
    process.exit(1);
  }
  console.log(`raw-values: PASS, ${files.length} files under ${ROOTS.join("/ and ")}/ hold no raw length, time or colour outside the theme and no switched-off class name; ${Object.keys(known).length} old layout measures are still listed in ${KNOWN_NAME}`);
}
