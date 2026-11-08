import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "src";
const THEME_NAME = "src/ui/theme.css";
const LIMIT_MS = 300;
const MOTION_LAYERS = new Set(["ui", "screens", "shell", "platform"]);
const CLASS = /(?<![\w-])(duration|ease|delay)-([^\s"'`<>{}]+)/g;
const ENDLESS_CLASS = /(?<![\w-])animate-(?:spin|pulse|ping|bounce)\b/g;
const INFINITE = /\binfinite\b|\biterations?\s*:\s*Infinity\b/g;
const TIME = /(?<![A-Za-z0-9_.])(\d*\.?\d+)(ms|s)(?![\w-])/g;
const MOTION_DECLARATION = /(?<![\w-])(?:transition|animation)(?:-(?:duration|delay|timing-function))?\s*:\s*([^;}]*)/g;
const THEME_TIME_DECLARATION = /(--[a-z0-9-]*(?:duration|delay)[a-z0-9-]*)\s*:\s*([^;}]*)/gi;
const THEME_EASING_DECLARATION = /--ease-[\w-]+\s*:[^;}]*/g;
const EASING_FUNCTION = /\b(?:cubic-bezier|steps|linear)\(/g;
const APPLY = /@apply\s+([^;}]*)/g;
const MOTION_NUMBER = [
  /(?<![\w$])(?:duration|delay|easing|transitionDuration|transitionDelay|animationDuration|animationDelay|transition|animation)\s*:\s*[^,;)}\n]*\d/,
  /(?<![\w$])(?:duration|delay)\s*=\s*\{\s*\d/,
  /(?<![A-Za-z0-9_.])\d*\.?\d+ms\b/,
];
const MOTION_WORD = /transition|animation|animate|duration|delay|easing|\bease\b/i;
const SECONDS = /(?<![A-Za-z0-9_.])\d*\.?\d+s\b/;
const ENDLESS = "is an endless animation; none is allowed";
const SENDING_SHEET = "src/ui/motion.css";
const SENDING_RULE = ".sending-bar {\n  animation: sending 1200ms cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;\n}";

const layerOf = (name) => name.replace(/^src\//, "").split("/")[0];

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const millis = (number, unit) => Number(number) * (unit === "s" ? 1000 : 1);

function namesIn(theme, prefix) {
  return new Set([...theme.matchAll(new RegExp("--" + prefix + "-([a-z0-9-]+)\\s*:", "g"))].map((match) => match[1]));
}

function classProblems(name, text, lineAt, allowed) {
  const found = [];
  for (const match of text.matchAll(CLASS)) {
    const [whole, kind, value] = match;
    const names = allowed[kind];
    if (names.has(value.replace(/!$/, ""))) continue;
    const held = names.size ? "it holds: " + [...names].join(", ") : "it holds none";
    const what = kind === "delay" ? "a delay class, and the theme holds no delay value" : "a " + kind + " class the theme does not hold (" + held + "); use one of those";
    found.push(`${name}:${lineAt(match.index)}: ${whole} is ${what}`);
  }
  return found;
}

function cssProblems(name, source, allowed) {
  const found = [];
  const text = name === SENDING_SHEET ? source.replace(SENDING_RULE, (kept) => kept.replace(/[^\n]/g, " ")) : source;
  const say = (index, what) => found.push(`${name}:${lineOf(text, index)}: ${what}`);
  for (const match of text.matchAll(MOTION_DECLARATION)) {
    if ([...match[1].matchAll(TIME)].length) say(match.index, `${match[0].trim()} is a literal time in a transition or animation; read a --transition-duration-* value with var()`);
  }
  for (const match of text.matchAll(THEME_TIME_DECLARATION)) {
    for (const time of match[2].matchAll(TIME)) {
      if (millis(time[1], time[2]) > LIMIT_MS) say(match.index, `${match[1]}: ${match[2].trim()} is a theme time over ${LIMIT_MS} ms`);
    }
  }
  const outside = text.replace(THEME_EASING_DECLARATION, (kept) => kept.replace(/[^\n]/g, " "));
  for (const match of outside.matchAll(EASING_FUNCTION)) say(match.index, `${match[0]} is an easing written in place; only a --ease-* line in the theme holds one`);
  for (const match of text.matchAll(INFINITE)) say(match.index, `${match[0]} ${ENDLESS}`);
  for (const match of text.matchAll(ENDLESS_CLASS)) say(match.index, `${match[0]} ${ENDLESS}`);
  for (const apply of text.matchAll(APPLY)) {
    const start = apply.index + apply[0].indexOf(apply[1]);
    found.push(...classProblems(name, apply[1], (index) => lineOf(text, start + index), allowed));
  }
  return found;
}

function codeProblems(name, text, allowed) {
  const found = [];
  const inMotionLayer = MOTION_LAYERS.has(layerOf(name));
  text.split("\n").forEach((line, at) => {
    const classes = classProblems(name, line, () => at + 1, allowed);
    found.push(...classes);
    for (const match of line.matchAll(ENDLESS_CLASS)) found.push(`${name}:${at + 1}: ${match[0]} ${ENDLESS}`);
    for (const match of line.matchAll(INFINITE)) found.push(`${name}:${at + 1}: ${match[0]} ${ENDLESS}`);
    if (!inMotionLayer || classes.length) return;
    const hit = MOTION_NUMBER.map((pattern) => pattern.exec(line)).find(Boolean) ?? (MOTION_WORD.test(line) ? SECONDS.exec(line) : null);
    if (hit) found.push(`${name}:${at + 1}: ${hit[0].trim()} is a millisecond number for motion in code; the theme holds the times (--transition-duration-*)`);
  });
  return found;
}

const FIRST_DURATION = /--transition-duration-[a-z0-9-]+\s*:/;
const DEFAULTS = [
  ["--default-transition-duration", /--default-transition-duration\s*:\s*var\(\s*--transition-duration-[a-z0-9-]+\s*\)/, "--transition-duration-"],
  ["--default-transition-timing-function", /--default-transition-timing-function\s*:\s*var\(\s*--ease-[a-z0-9-]+\s*\)/, "--ease-"],
];

function defaultsProblems(theme) {
  const first = FIRST_DURATION.exec(theme);
  if (!first) return [];
  return DEFAULTS.filter(([, held]) => !held.test(theme)).map(([property, , value]) => `${THEME_NAME}:${lineOf(theme, first.index)}: ${property} is not set to var(${value}…), so a bare transition class would use Tailwind's own default`);
}

export function motionProblems(files, theme = files.find((file) => file.name === THEME_NAME)?.text ?? "") {
  const allowed = { duration: namesIn(theme, "transition-duration"), ease: namesIn(theme, "ease"), delay: new Set() };
  const found = defaultsProblems(theme);
  for (const { name, text } of files) found.push(...(name.endsWith(".css") ? cssProblems(name, text, allowed) : codeProblems(name, text, allowed)));
  return found;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(?:tsx?|css)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = walk(ROOT).map((file) => ({ name: file.split(path.sep).join("/"), text: fs.readFileSync(file, "utf8") }));
  const problems = motionProblems(files);
  if (problems.length) {
    for (const problem of problems) console.log(problem);
    console.log(`motion-rules: FAIL, ${problems.length} problems against the theme's motion values`);
    process.exit(1);
  }
  console.log(`motion-rules: PASS, ${files.length} files under ${ROOT}/ use only the theme's motion values but the sending bar's one rule, hold no theme time over ${LIMIT_MS} ms, run no endless animation but the sending bar and keep no millisecond number for motion in code`);
}
