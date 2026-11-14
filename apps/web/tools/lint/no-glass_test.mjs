import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./no-glass.mjs", import.meta.url));
const APP = fileURLToPath(new URL("../..", import.meta.url));

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });

test("the real tree holds no glass", () => {
  const result = run(APP);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no-glass: PASS/);
});

test("glass fails anywhere, in the theme and the floating parts too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-no-glass-"));
  try {
    fs.mkdirSync(path.join(dir, "src/ui"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/ui/theme.css"), "@utility frost {\n  backdrop-filter: blur(var(--blur));\n}\n");
    fs.writeFileSync(path.join(dir, "src/ui/float.tsx"), "export const Float = () => <div className=\"frost\" />;\n");
    fs.writeFileSync(path.join(dir, "src/ui/plain.tsx"), "export const Plain = () => <div className=\"bg-panel backdrop-blur-sm\" />;\n");
    const result = run(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /src\/ui\/theme\.css:1: frost /);
    assert.match(result.stdout, /src\/ui\/theme\.css:2: backdrop-filter /);
    assert.match(result.stdout, /src\/ui\/float\.tsx:1: frost /);
    assert.match(result.stdout, /src\/ui\/plain\.tsx:1: backdrop-blur /);
    assert.match(result.stdout, /no-glass: FAIL, 4 /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
