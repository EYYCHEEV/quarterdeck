import assert from "node:assert/strict";
import { test } from "node:test";

const THEME_FILE = "src/ui/theme.css";
const THEME = [
  "@theme static {",
  "  --color-*: initial;",
  "  --color-page: black;",
  "  --color-ink: white;",
  "  --text-body: 15px;",
  "  --spacing-s1: 4px;",
  "  --radius-key: 4px;",
  "  --font-weight-strong: 600;",
  "  --line-w: 1px;",
  "  --ease-arrive: ease;",
  "}",
  ':root[data-appearance="light"] {',
  "  --color-page: white;",
  "  --color-ink: black;",
  "}",
  "body {",
  "  color: var(--color-ink);",
  "}",
  "",
].join("\n");
const BUILT =
  ":root,:host{--color-page:black;--color-ink:white;--text-body:15px;--spacing-s1:4px;--radius-key:4px;--font-weight-strong:600;--line-w:1px;--ease-arrive:ease}" +
  ":root[data-appearance=light]{--color-page:white;--color-ink:black}" +
  "body{color:var(--color-ink)}";

const check = async (name, text, others = [], theme = THEME) => {
  const { themeVarProblems } = await import("./theme-vars.mjs");
  return themeVarProblems([{ name: THEME_FILE, text: theme }, { name, text }, ...others], [theme], BUILT);
};

const view = (line) => 'export const View = () => <div className="' + line + '" />;\n';

test("a read of a name the theme defines passes, in the theme's own rules and in a class", async () => {
  const { problems, runtime } = await check("src/ui/probe.tsx", view("shadow-[inset_0_0_0_var(--line-w)_var(--color-ink)]"));
  assert.deepEqual([problems, runtime], [[], []]);
});

for (const name of ["--color-brass", "--text-huge", "--spacing-s9", "--radius-pill", "--font-weight-heavy", "--line-w-thick", "--ease-bounce"]) {
  test("a read of " + name + ", a name in a theme namespace that nothing defines, fails with its file and line", async () => {
    const { problems } = await check("public/probe.css", ".probe {\n  color: var(" + name + ");\n}\n");
    assert.equal(problems.length, 1);
    assert.ok(problems[0].startsWith("public/probe.css:2: " + name + " "), problems[0]);
    assert.match(problems[0], /nothing defines it/);
  });
}

test("a dropped theme name fails in a class string too, and a fallback value does not excuse it", async () => {
  const { problems } = await check("src/ui/probe.tsx", view("bg-[var(--color-brass)] text-[color:var(--color-brass,white)]"));
  assert.equal(problems.length, 2);
  for (const problem of problems) assert.ok(problem.startsWith("src/ui/probe.tsx:1: --color-brass "), problem);
});

test("a local value outside the theme's namespaces passes, set or not", async () => {
  const { problems } = await check("src/ui/probe.css", ".fold {\n  height: var(--fold-h);\n  margin: var(--fold-gap, 0);\n}\n");
  assert.deepEqual(problems, []);
});

test("a local name inside a theme namespace passes when a file sets it: in a style sheet, a style object, a class or by setProperty", async () => {
  const sets = [
    { name: "public/a.css", text: ".dock {\n  --spacing-dock: 12px;\n}\n" },
    { name: "src/ui/b.tsx", text: 'export const style = { "--color-ring": "red" };\n' },
    { name: "src/ui/c.tsx", text: view("[--radius-here:4px]") },
    { name: "src/ui/d.ts", text: 'export const set = (el) => el.style.setProperty("--text-fit", "1em");\n' },
  ];
  const reads = ".probe {\n  padding: var(--spacing-dock);\n  color: var(--color-ring);\n  border-radius: var(--radius-here);\n  font-size: var(--text-fit);\n}\n";
  const { problems } = await check("public/probe.css", reads, sets);
  assert.deepEqual(problems, []);
});

test("a read whose name is built at run time is listed as not checked, and is no problem", async () => {
  const { problems, runtime } = await check("src/domain/avatar.ts", 'export const avatarColor = (slot) => "var(--color-avatar-" + slot + ")";\n');
  assert.deepEqual(problems, []);
  assert.equal(runtime.length, 1);
  assert.ok(runtime[0].startsWith("src/domain/avatar.ts:1: var(--color-avatar-"), runtime[0]);
});

test("a theme name the built style sheet lacks still fails, naming the look", async () => {
  const theme = THEME.replace("  --radius-key: 4px;\n", "  --radius-key: 4px;\n  --radius-panel: 6px;\n");
  const { problems } = await check("public/probe.css", ".probe {\n  border-radius: var(--radius-panel);\n}\n", [], theme);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].startsWith("public/probe.css:2: --radius-panel is a theme variable the built app.css does not define in the dark or light look"), problems[0]);
});

test("the PASS line names every run-time read it could not check, and the FAIL line counts the problems", async () => {
  const { themeVarReport } = await import("./theme-vars.mjs");
  const read = 'src/domain/avatar.ts:10: var(--color-avatar-" + slot + ")";';
  const pass = themeVarReport({ problems: [], runtime: [read] }, 12);
  assert.equal(pass.ok, true);
  assert.equal(pass.lines.length, 1);
  assert.ok(pass.lines[0].startsWith("theme-vars: PASS, 12 files "), pass.lines[0]);
  assert.ok(pass.lines[0].includes("1 var() reads build their name at run time and are not checked:\n  " + read), pass.lines[0]);
  const fail = themeVarReport({ problems: ["one", "two"], runtime: [] }, 12);
  assert.equal(fail.ok, false);
  assert.deepEqual(fail.lines.slice(0, 2), ["one", "two"]);
  assert.ok(fail.lines[2].startsWith("theme-vars: FAIL, 2 "), fail.lines[2]);
  assert.ok(fail.lines[2].includes("no var() read builds its name at run time"), fail.lines[2]);
});
