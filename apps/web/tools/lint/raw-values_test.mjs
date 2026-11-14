import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./raw-values.mjs", import.meta.url));
const KNOWN = fileURLToPath(new URL("./raw-values-known.json", import.meta.url));
const APP = fileURLToPath(new URL("../..", import.meta.url));

const problemsOf = async (name, text) => {
  const { rawValueProblems } = await import("./raw-values.mjs");
  return rawValueProblems([{ name, text }]);
};

const view = (line) => "export const View = () => <div className=\"" + line + "\" />;\n";
const styled = (style) => "export const View = () => <i style={{ " + style + " }} />;\n";
const sheet = (rule) => ".a { " + rule + " }\n";

const eachFails = async (name, wrap, samples) => {
  for (const sample of samples) {
    const found = await problemsOf(name, "const a = 1;\n" + wrap(sample));
    assert.equal(found.length, 1, sample + ": " + JSON.stringify(found));
    assert.ok(found[0].startsWith(name + ":2: "), found[0]);
  }
};

test("classes named for the design's steps pass, and so do shares of the whole", async () => {
  const line = "min-h-key-h gap-s2 p-s3 -mt-hair rounded-key rounded-none text-label font-strong leading-snug tracking-label bg-hand text-ink-2 border-line-3 p-0 inset-0 w-full w-1/2 -translate-x-1/2 z-10 flex-1 grid-cols-3 grid-cols-[minmax(0,1fr)_auto] aspect-[4/3] [overflow-wrap:anywhere] wide:hover:bg-panel";
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view(line)), []);
});

test("a width condition in brackets and a bracket that reads a token pass", async () => {
  const line = "min-[420px]:hidden min-[420px]:max-wide:hidden max-h-[calc(100dvh_-_var(--spacing-s6))] pt-[max(var(--spacing-s2),env(safe-area-inset-top))] w-[88%] max-h-[50vh]";
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view(line)), []);
  await eachFails("src/ui/probe.tsx", view, ["min-[420px]:w-[320px]", "pt-[max(8px,env(safe-area-inset-top))]"]);
});

test("a length or a time in brackets fails and names the file and line", async () => {
  await eachFails("src/ui/probe.tsx", view, ["min-h-[46px]", "w-[min(100%,320px)]", "tracking-[-.02em]", "text-[.86em]", "pt-[max(8px,env(safe-area-inset-top))]", "mt-[0.75rem]", "duration-[300ms]", "upright:max-w-[720px]"]);
});

test("a class from Tailwind's own number and name scales fails, since it builds nothing", async () => {
  await eachFails("src/screens/probe/probe.tsx", view, ["p-3", "gap-2.5", "-mt-1", "px-px", "size-11", "w-56", "min-h-12", "top-3", "text-sm", "text-base", "font-medium", "font-semibold", "rounded", "rounded-lg", "rounded-full", "rounded-t-md", "leading-6", "leading-relaxed", "tracking-wide", "shadow-lg", "hover:p-3", "wide:text-sm", "p-3!"]);
});

test("a class from the old theme fails", async () => {
  await eachFails("src/ui/probe.tsx", view, ["text-small", "text-caps", "text-screen-wide", "rounded-control", "rounded-card", "shadow-pop", "bg-brass", "text-brass-ink", "border-brass-edge", "brass-fill", "text-red", "bg-red-soft", "text-green", "bg-blue-soft", "text-violet", "text-link", "bg-hover", "bg-bubble", "text-chat-bot-ink", "bg-avatar-1"]);
});

test("a see-through step on a colour fails, and a fraction passes", async () => {
  await eachFails("src/ui/probe.tsx", view, ["border-current/25", "decoration-ink/35", "bg-hand/40"]);
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view("w-1/2 basis-1/3 -translate-y-1/2")), []);
});

test("colour math outside the theme fails", async () => {
  await eachFails("src/ui/probe.tsx", styled, ['borderColor: "color-mix(in oklab, var(--color-stop) 50%, transparent)"']);
  await eachFails("public/probe.css", sheet, ["background: color-mix(in srgb, var(--color-hand) 10%, transparent);"]);
});

test("a raw length written into a style prop fails", async () => {
  await eachFails("src/ui/probe.tsx", styled, ["height: 168", 'bottom: "0.75rem"', 'outline: "2px solid " + ring', 'flex: "1 1 15rem"', "marginLeft: 4, opacity: 1"]);
});

test("a style prop that holds a measured place, a share or a live value passes", async () => {
  for (const style of ["left: spot.x, top: spot.y", 'width: "52%"', 'gridTemplateColumns: "auto minmax(0, 1fr)"', '"--progress": percent + "%"', "height: 0", "height", "opacity: 0.6"]) {
    assert.deepEqual(await problemsOf("src/ui/probe.tsx", styled(style)), [], style);
  }
});

test("a raw length, time or colour in a sheet outside the theme fails", async () => {
  await eachFails("public/probe.css", sheet, ["padding: 12px;", "max-height: 10rem;", "letter-spacing: .1em;", "color: #fff;", "color: rgb(0 0 0 / 0.5);", "transition: opacity 200ms;", "animation-duration: 0.3s;"]);
  await eachFails("src/ui/motion.css", sheet, ["translate: 0 4px;"]);
});

test("a sheet that reads tokens, shares of the whole and width conditions passes", async () => {
  const text = [
    ".a { padding: var(--spacing-s3); max-width: 100%; flex: 1; scale: 0.97; grid-template-columns: minmax(0, 1fr) auto; height: 100dvh; }",
    "@media (min-width: 700px) {",
    "  .a { display: none; }",
    "}",
    "@container (min-width: 720px) {",
    "  .a { translate: 150% 0; }",
    "}",
    "#stage > aside { order: 2; }",
    "",
  ].join("\n");
  assert.deepEqual(await problemsOf("public/probe.css", text), []);
});

test("the theme, the tests and the bot-made example pages keep their own values", async () => {
  assert.deepEqual(await problemsOf("src/ui/theme.css", "@theme { --spacing-s3: 12px; --color-page: #05090d; --dur-tick: 1200ms; }\n"), []);
  assert.deepEqual(await problemsOf("src/ui/probe_test.mjs", view("p-3 min-h-[46px] bg-brass")), []);
  assert.deepEqual(await problemsOf("src/data/pages/probe.html", "<p style=\"margin: 12px\">x</p>\n"), []);
});

test("a listed old layout measure passes until its stage, and nothing else rides on the list", async () => {
  const { rawValueProblems } = await import("./raw-values.mjs");
  const files = [{ name: "src/screens/probe/probe.tsx", text: view("max-w-[720px] wide:w-[400px] gap-s2") }];
  assert.deepEqual(rawValueProblems(files, { "max-w-[720px]": "stage 3", "w-[400px]": "stage 3" }), []);
  const found = rawValueProblems(files, { "max-w-[720px]": "stage 3" });
  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/screens\/probe\/probe\.tsx:1: wide:w-\[400px\] /);
  assert.equal(rawValueProblems([{ name: "public/probe.css", text: sheet("max-width: 720px;") }], { "max-w-[720px]": "stage 3" }).length, 2);
});

test("a listed name that nothing uses any more fails, so the list only shrinks", async () => {
  const { rawValueProblems } = await import("./raw-values.mjs");
  const files = [{ name: "src/screens/probe/probe.tsx", text: view("gap-s2") }];
  const found = rawValueProblems(files, { "max-w-[720px]": "stage 3" });
  assert.equal(found.length, 1);
  assert.match(found[0], /^tools\/lint\/raw-values-known\.json: max-w-\[720px\] /);
});

test("every entry of the real list is a bracketed measure and names the later stage that removes it", () => {
  const known = JSON.parse(fs.readFileSync(KNOWN, "utf8"));
  for (const [name, stage] of Object.entries(known)) {
    assert.match(name, /^-?[a-z][a-z-]*-\[[^\]\s]+\]$/, name);
    assert.match(stage, /^stage [2-9]\b/, name);
  }
});

test("the real tree passes the script", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: APP, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /raw-values: PASS/);
});

test("the script fails a tree with a raw value and prints the line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-raw-values-"));
  try {
    fs.mkdirSync(path.join(dir, "src/ui"), { recursive: true });
    fs.mkdirSync(path.join(dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/ui/probe.tsx"), view("gap-s2 min-h-[46px]"));
    fs.writeFileSync(path.join(dir, "public/probe.css"), sheet("padding: 12px;"));
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /src\/ui\/probe\.tsx:1: min-h-\[46px\]/);
    assert.match(result.stdout, /public\/probe\.css:1: /);
    assert.match(result.stdout, /raw-values: FAIL, 2 /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
