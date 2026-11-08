import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./arch-check.mjs", import.meta.url));
const THEME = "@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    transition: none !important;\n    animation: none !important;\n  }\n}\n";

function archCheckWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-arch-motion-"));
  try {
    for (const [name, source] of Object.entries({ "ui/theme.css": THEME, ...files })) {
      fs.mkdirSync(path.dirname(path.join(dir, "src", name)), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", name), source);
    }
    return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NAMES = [
  ["startViewTransition", "export const go = (update: () => void) => document.startViewTransition(update);\n"],
  [".animate(", "export const fade = (element: HTMLElement) => element.animate([], { duration: 1 });\n"],
  ["getAnimations", "export const running = () => document.getAnimations();\n"],
  ["a matchMedia of the reduced-motion query", "export const calm = () => window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches;\n"],
  ["a matchMedia of the reduced-motion query in a template", "export const calm = () => window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;\n"],
];

for (const [what, source] of NAMES) {
  test("the layer check refuses " + what + " in a screen", () => {
    const result = archCheckWith({ "screens/probe/probe.tsx": source });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /screens\/probe\/probe\.tsx:1: .* is a /);
  });

  test("the layer check refuses " + what + " in ui, shell and data", () => {
    for (const layer of ["ui", "shell", "data"]) {
      const result = archCheckWith({ [layer + "/probe.ts"]: source });
      assert.equal(result.status, 1, layer + "\n" + result.stdout);
      assert.match(result.stdout, new RegExp(layer + "/probe\\.ts:1: "));
    }
  });

  test("the layer check lets platform hold " + what, () => {
    const result = archCheckWith({ "platform/probe.ts": source });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /arch-check: PASS/);
  });
}

test("the layer check still lets a screen ask matchMedia about a width", () => {
  const result = archCheckWith({ "screens/probe/probe.tsx": "export const wide = () => window.matchMedia(\"(min-width: 800px)\").matches;\n" });
  assert.equal(result.status, 0, result.stdout);
});

test("the layer check still lets the theme keep the CSS reduced-motion rule", () => {
  const result = archCheckWith({ "platform/probe.ts": "export const ready = true;\n" });
  assert.equal(result.status, 0, result.stdout);
});
