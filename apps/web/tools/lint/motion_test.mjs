import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./motion.mjs", import.meta.url));
const THEME_FILE = "src/ui/theme.css";
const THEME = [
  "@theme static {",
  "  --transition-duration-quick: 100ms;",
  "  --transition-duration-standard: 200ms;",
  "  --transition-duration-screen: 240ms;",
  "  --ease-arrive: cubic-bezier(0.2, 0, 0, 1);",
  "  --ease-leave: cubic-bezier(0.4, 0, 1, 1);",
  "  --default-transition-duration: var(--transition-duration-standard);",
  "  --default-transition-timing-function: var(--ease-arrive);",
  "}",
  "@media (prefers-reduced-motion: reduce) {",
  "  *, *::before, *::after {",
  "    transition: none !important;",
  "    animation: none !important;",
  "  }",
  "}",
  "",
].join("\n");

const problemsOf = async (name, text, theme = THEME) => {
  const { motionProblems } = await import("./motion.mjs");
  return motionProblems([{ name: THEME_FILE, text: theme }, { name, text }], theme);
};

const view = (line) => "export const View = () => <div className=\"" + line + "\" />;\n";

test("the theme's own motion values and the reduced-motion rule pass", async () => {
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view("duration-quick ease-arrive")), []);
});

test("a theme with motion durations must set both Tailwind defaults to its own values", async () => {
  const bare = THEME.replace(/  --default-[^\n]*\n/g, "");
  const { motionProblems } = await import("./motion.mjs");
  const found = motionProblems([{ name: THEME_FILE, text: bare }], bare);
  assert.equal(found.length, 2);
  assert.match(found[0], /^src\/ui\/theme\.css:2: .*--default-transition-duration/);
  assert.match(found[1], /^src\/ui\/theme\.css:2: .*--default-transition-timing-function/);
  const literal = THEME.replace("var(--transition-duration-standard)", "150ms").replace("var(--ease-arrive);", "ease;");
  assert.equal(motionProblems([{ name: THEME_FILE, text: literal }], literal).length, 2);
  const timingOnly = bare.replace("}\n@media", "  --default-transition-timing-function: var(--ease-leave);\n}\n@media");
  assert.equal(motionProblems([{ name: THEME_FILE, text: timingOnly }], timingOnly).length, 1);
  assert.deepEqual(motionProblems([{ name: THEME_FILE, text: THEME }], THEME), []);
  const none = "@media (prefers-reduced-motion: reduce) {\n  * { transition: none !important; }\n}\n";
  assert.deepEqual(motionProblems([{ name: THEME_FILE, text: none }], none), []);
});

test("a duration class with a number fails and names the file and line", async () => {
  const found = await problemsOf("src/ui/probe.tsx", "const a = 1;\n" + view("p-2 duration-150"));
  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/ui\/probe\.tsx:2: duration-150\b/);
});

test("an arbitrary duration or easing class fails", async () => {
  const found = await problemsOf("src/ui/probe.tsx", view("duration-[300ms] ease-[cubic-bezier(0,0,1,1)]"));
  assert.equal(found.length, 2);
});

test("a variant prefix does not hide a bad duration, and a theme duration passes under one", async () => {
  assert.equal((await problemsOf("src/ui/probe.tsx", view("md:hover:duration-300"))).length, 1);
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view("md:hover:duration-screen duration-quick!")), []);
});

test("a built-in easing name fails and the theme easings pass", async () => {
  assert.equal((await problemsOf("src/ui/probe.tsx", view("ease-in-out"))).length, 1);
  assert.equal((await problemsOf("src/ui/probe.tsx", view("ease-out"))).length, 1);
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view("ease-leave")), []);
});

test("a delay class fails, since the theme has no delay value", async () => {
  assert.equal((await problemsOf("src/ui/probe.tsx", view("delay-100"))).length, 1);
});

test("the names a class may use come from the theme, so a name the theme lacks fails", async () => {
  assert.equal((await problemsOf("src/ui/probe.tsx", view("duration-slow"))).length, 1);
  const withSlow = THEME.replace("}\n@media", "  --transition-duration-slow: 280ms;\n}\n@media");
  assert.deepEqual(await problemsOf("src/ui/probe.tsx", view("duration-slow"), withSlow), []);
});

test("a duration class inside @apply is checked like one in a component", async () => {
  assert.equal((await problemsOf("src/ui/probe.css", ".a { @apply duration-300; }\n")).length, 1);
  assert.deepEqual(await problemsOf("src/ui/probe.css", ".a { @apply duration-quick ease-arrive; }\n"), []);
});

test("a literal time in a CSS transition or animation fails", async () => {
  assert.equal((await problemsOf("src/ui/probe.css", ".a { transition: opacity 200ms var(--ease-arrive); }\n")).length, 1);
  assert.equal((await problemsOf("src/ui/probe.css", ".a { animation-duration: 0.3s; }\n")).length, 1);
  assert.equal((await problemsOf("src/ui/probe.css", ".a { animation-delay: 50ms; }\n")).length, 1);
  assert.equal((await problemsOf("src/ui/probe.css", ".a { transition-duration: 1s; }\n")).length, 1);
});

test("a CSS transition or animation that reads the theme through var() passes", async () => {
  assert.deepEqual(await problemsOf("src/ui/probe.css", ".a { transition: opacity var(--transition-duration-standard) var(--ease-arrive); }\n.b { animation: leave var(--transition-duration-quick) var(--ease-leave) both; }\n"), []);
});

test("a cubic-bezier or steps easing outside a theme easing line fails", async () => {
  assert.equal((await problemsOf("src/ui/probe.css", ".a { transition-timing-function: cubic-bezier(0, 0, 1, 1); }\n")).length, 1);
  assert.equal((await problemsOf("src/ui/probe.css", ".a { animation-timing-function: steps(4); }\n")).length, 1);
});

test("a theme duration or delay over 300 ms fails, in ms or in seconds", async () => {
  assert.equal((await problemsOf("src/ui/probe.css", ":root { --transition-duration-slow: 400ms; }\n")).length, 1);
  assert.equal((await problemsOf("src/ui/probe.css", ":root { --animation-delay-late: 0.4s; }\n")).length, 1);
  assert.deepEqual(await problemsOf("src/ui/probe.css", ":root { --transition-duration-edge: 300ms; --transition-duration-tiny: 0.1s; }\n"), []);
});

test("the theme file itself is held to the 300 ms limit", async () => {
  const slow = THEME.replace("240ms", "301ms");
  const { motionProblems } = await import("./motion.mjs");
  const found = motionProblems([{ name: THEME_FILE, text: slow }], slow);
  assert.equal(found.length, 1);
  assert.match(found[0], /^src\/ui\/theme\.css:4: /);
});

test("an endless animation fails in CSS and in a class", async () => {
  assert.equal((await problemsOf("src/ui/probe.css", ".a { animation: spin var(--transition-duration-screen) linear infinite; }\n")).length, 1);
  assert.equal((await problemsOf("src/ui/probe.css", ".a { animation-iteration-count: infinite; }\n")).length, 1);
  for (const name of ["animate-spin", "animate-pulse", "animate-ping", "animate-bounce"]) {
    assert.equal((await problemsOf("src/ui/probe.tsx", view(name))).length, 1, name);
  }
});

const SENDING_RULE = ".sending-bar {\n  animation: sending 1200ms cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;\n}\n";

test("the sending bar is the one exception: its approved rule in motion.css passes with its own time, easing and endless run", async () => {
  assert.deepEqual(await problemsOf("src/ui/motion.css", ".leave { animation: leave var(--transition-duration-quick) var(--ease-leave) both; }\n" + SENDING_RULE), []);
});

test("past the sending bar's exact rule, every endless animation, literal time and written-in easing still fails", async () => {
  assert.equal((await problemsOf("src/ui/probe.css", SENDING_RULE)).length, 3, "the rule outside motion.css");
  assert.equal((await problemsOf("src/ui/motion.css", SENDING_RULE.replace(".sending-bar", ".other-bar"))).length, 3, "another class with the same rule");
  assert.equal((await problemsOf("src/ui/motion.css", SENDING_RULE.replace("1200ms", "2400ms"))).length, 3, "the sending bar at another speed");
  assert.equal((await problemsOf("src/ui/motion.css", SENDING_RULE.replace("alternate;", "alternate;\n  transition: opacity 400ms;"))).length, 4, "the sending bar with one more line");
  const second = await problemsOf("src/ui/motion.css", SENDING_RULE + ".a { animation-iteration-count: infinite; }\n");
  assert.deepEqual(second, ["src/ui/motion.css:4: infinite is an endless animation; none is allowed"], "a second endless rule beside it, on its own line");
});

test("a millisecond number for motion in a screen part fails", async () => {
  const lines = [
    "const a = { duration: 200 };",
    "const b = { delay: 150 };",
    "const c = { transition: \"opacity 200ms\" };",
    "const d = { transition: \"0.2s\" };",
    "const e = \"120ms\";",
  ];
  for (const where of ["ui", "screens/probe", "shell", "platform"]) {
    const found = await problemsOf("src/" + where + "/probe.ts", lines.join("\n") + "\n");
    assert.deepEqual(found.map((one) => Number(/probe\.ts:(\d+):/.exec(one)[1])), [1, 2, 3, 4, 5], where);
  }
});

test("TS that holds a time without a motion number passes", async () => {
  const text = ["const a = { duration: ready };", "const b = { delay: wait };", "const c = { transition: \"none\" };", "const label = \"10s\";", "const wait = setTimeout(go, 200);"].join("\n") + "\n";
  assert.deepEqual(await problemsOf("src/ui/probe.ts", text), []);
});

test("data and domain keep their own timer numbers", async () => {
  const text = "export const refresh = { delay: 3000, duration: 45000 };\n";
  assert.deepEqual(await problemsOf("src/data/probe.ts", text), []);
  assert.deepEqual(await problemsOf("src/domain/probe.ts", text), []);
});

test("the real tree passes the script", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /motion-rules: PASS/);
});

test("the script fails a tree with a bad duration and prints the line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-motion-rules-"));
  try {
    fs.mkdirSync(path.join(dir, "src/ui"), { recursive: true });
    fs.writeFileSync(path.join(dir, THEME_FILE), THEME);
    fs.writeFileSync(path.join(dir, "src/ui/probe.tsx"), view("duration-150"));
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /src\/ui\/probe\.tsx:1: duration-150/);
    assert.match(result.stdout, /motion-rules: FAIL, 1 /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
