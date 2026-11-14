import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const THEME_FILE = "src/ui/theme.css";
const LIGHT = ':root[data-appearance="light"]';

const COLOURS = [
  ["page", "#05090d", "#edf1f3"],
  ["side", "#0a1118", "#e3e9ed"],
  ["well", "#0a1118", "#e3e9ed"],
  ["panel", "#101a24", "#ffffff"],
  ["control", "#172431", "#d7e0e6"],
  ["raised", "#172431", "#d7e0e6"],
  ["line", "#1f303f", "#c3cfd8"],
  ["line-3", "#4d7196", "#6b8090"],
  ["ink", "#e3edf3", "#0c1820"],
  ["ink-2", "#9db0bf", "#3d5060"],
  ["ink-3", "#6f8596", "#566979"],
  ["hand", "#5cc8ff", "#0a6399"],
  ["hand-edge", "#397c9e", "#0b4c75"],
  ["on-hand", "#021520", "#ffffff"],
  ["wait", "#ffb224", "#8f5200"],
  ["wait-fill", "#ffb224", "#ffb224"],
  ["wait-tint", "#2d2411", "#f0e7d2"],
  ["on-wait", "#1a1000", "#1a1000"],
  ["stop", "#ff6b5e", "#b3261e"],
  ["moving", "#7ddc7a", "#1a6e2e"],
  ["new", "#b39cff", "#5b3fc4"],
  ["scrim", "rgb(0 0 0 / 0.62)", "rgb(12 24 32 / 0.46)"],
];

const SHARED = [
  ["--text-label", "12px"],
  ["--text-meta", "13px"],
  ["--text-body", "15px"],
  ["--text-lead", "17px"],
  ["--text-title", "20px"],
  ["--text-title--line-height", "1.35"],
  ["--text-display", "26px"],
  ["--text-display--line-height", "1.35"],
  ["--text-ref", "0.87em"],
  ["--font-weight-regular", "400"],
  ["--font-weight-strong", "600"],
  ["--leading-none", "1"],
  ["--leading-tight", "1.2"],
  ["--leading-snug", "1.35"],
  ["--leading-body", "1.5"],
  ["--tracking-key", "0.06em"],
  ["--tracking-label", "0.08em"],
  ["--tracking-brand", "0.14em"],
  ["--radius-tag", "2px"],
  ["--radius-key", "4px"],
  ["--radius-panel", "6px"],
  ["--radius-sheet", "14px"],
  ["--spacing-s1", "4px"],
  ["--spacing-s2", "8px"],
  ["--spacing-s3", "12px"],
  ["--spacing-s4", "16px"],
  ["--spacing-s5", "24px"],
  ["--spacing-s6", "32px"],
  ["--spacing-s7", "48px"],
  ["--spacing-hair", "2px"],
  ["--spacing-nudge", "1px"],
  ["--spacing-hit", "44px"],
  ["--spacing-key-h", "34px"],
  ["--spacing-row", "36px"],
  ["--transition-duration-quick", "80ms"],
  ["--transition-duration-standard", "160ms"],
  ["--dur-blink", "1060ms"],
  ["--dur-tick", "1200ms"],
  ["--spacing-0", "0px"],
  ["--spacing-float-pad", "76px"],
  ["--radius-round", "999px"],
  ["--radius-circle", "50%"],
];

const DROPPED = /--color-(?:brass|red|green|blue|violet|link|frost|bubble|hover|you|p0|p1|avatar|chat)\b[\w-]*/g;

const OLD_CLASSES = ["p-5", "gap-6", "mt-7", "size-11", "w-56", "min-h-12", "text-xs", "text-sm", "text-base", "text-small", "text-caps", "rounded-md", "rounded-lg", "rounded-control", "font-medium", "font-semibold", "font-bold", "leading-6", "tracking-wide", "bg-brass", "text-red", "text-violet"];
const NEW_CLASSES = ["p-s5", "gap-s2", "mt-hair", "size-hit", "min-h-key-h", "h-row", "text-label", "text-display", "rounded-key", "rounded-sheet", "font-strong", "leading-snug", "tracking-label", "bg-hand", "text-wait", "border-stop", "bg-moving", "bg-new", "p-0", "inset-0", "min-w-0", "-mt-s1", "pt-float-pad", "max-w-s7", "rounded-round", "rounded-t-sheet", "font-regular", "text-ref", "leading-body", "decoration-current", "text-inherit", "shadow-lift", "w-full", "top-1/2"];

const theme = fs.readFileSync(THEME_FILE, "utf8");

function blockAt(text, open) {
  let depth = 1;
  let at = open;
  while (depth && at < text.length) {
    if (text[at] === "{") depth++;
    else if (text[at] === "}") depth--;
    at++;
  }
  return text.slice(open, at - 1);
}

function declared(text) {
  return new Map([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim().replace(/\s+/g, " ")]));
}

function themeValues() {
  const values = new Map();
  for (const match of theme.matchAll(/@theme\b[^{]*\{/g)) {
    for (const [name, value] of declared(blockAt(theme, match.index + match[0].length))) values.set(name, value);
  }
  return values;
}

function lightValues() {
  const at = theme.indexOf(LIGHT);
  if (at < 0) return new Map();
  return declared(blockAt(theme, theme.indexOf("{", at) + 1));
}

function build(classes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-design-tokens-"));
  try {
    const input = path.join(dir, "probe.css");
    fs.writeFileSync(input, '@import "' + path.resolve(THEME_FILE) + '";\n@source inline("' + classes.join(" ") + '");\n');
    const result = spawnSync(path.join("node_modules", ".bin", "tailwindcss"), ["-i", input], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ruleFor = (css, name) => new RegExp("\\." + name.replace(/[.\/]/g, "\\\\$&") + "\\s*\\{").test(css);

test("the theme holds every colour of the design with its exact value in the dark look", () => {
  const dark = themeValues();
  for (const [name, value] of COLOURS) assert.equal(dark.get("--color-" + name), value, "--color-" + name);
});

test("the theme holds every colour of the design with its exact value in the light look", () => {
  const dark = themeValues();
  const light = lightValues();
  for (const [name, , value] of COLOURS) assert.equal(light.get("--color-" + name) ?? dark.get("--color-" + name), value, "--color-" + name);
});

test("the theme holds the design's type, corner, spacing and motion steps", () => {
  const values = themeValues();
  for (const [name, value] of SHARED) assert.equal(values.get(name), value, name);
});

test("the two faces are Plex Sans and Plex Mono, each with a system face behind it", () => {
  const values = themeValues();
  assert.match(values.get("--font-sans") ?? "", /^"Plex Sans", .*system-ui, sans-serif$/);
  assert.match(values.get("--font-mono") ?? "", /^"Plex Mono", .*ui-monospace, .*monospace$/);
});

test("keys and rows take the touch heights on a coarse pointer or under 1400 px", () => {
  const at = theme.indexOf("@media (max-width: 1399px), (pointer: coarse)");
  assert.notEqual(at, -1, "the density block");
  const block = blockAt(theme, theme.indexOf("{", at) + 1);
  const values = declared(block);
  assert.equal(values.get("--spacing-key-h"), "44px");
  assert.equal(values.get("--spacing-row"), "44px");
});

test("the theme keeps no colour name the design drops, no gradient and no file limit", () => {
  assert.deepEqual([...new Set(theme.match(DROPPED) ?? [])], []);
  assert.doesNotMatch(theme, /gradient\(/);
  assert.doesNotMatch(theme, /--files-max\b/);
  assert.match(theme, /--spacing:\s*initial;/);
});

test("a class from Tailwind's own scales or from the old theme builds nothing", () => {
  const css = build(OLD_CLASSES);
  assert.deepEqual(OLD_CLASSES.filter((name) => ruleFor(css, name)), []);
});

test("a class named for a step of the design builds a rule", () => {
  const css = build(NEW_CLASSES);
  assert.deepEqual(NEW_CLASSES.filter((name) => !ruleFor(css, name)), []);
});
