import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./design-check.mjs", import.meta.url), "utf8");

function checker(extra = {}) {
  const context = vm.createContext({ fs, os, path, spawn, spawnSync, Buffer, process: { argv: [], env: {} }, console, ...extra });
  vm.runInContext(source.slice(0, source.indexOf("\nconst build =")).replace(/^import .*;$/gm, ""), context);
  return (expression) => vm.runInContext(expression, context);
}

test("an equally fast host uses rate 4.00", () => {
  assert.equal(checker()("cpuRate(200, 200)").toFixed(2), "4.00");
});

test("a host 1.3 times slower uses rate 3.08", () => {
  assert.equal(checker()("cpuRate(260, 200)").toFixed(2), "3.08");
});

test("a host needing a rate below one fails instead of passing", () => {
  assert.throws(() => checker()("cpuRate(801, 200)"), /host too slow to emulate/);
  assert.equal(checker()("cpuRate(800, 200)"), 1);
});

test("a rate above sixteen fails instead of passing", () => {
  assert.throws(() => checker()("cpuRate(49, 200)"), /calibration out of range/);
  assert.equal(checker()("cpuRate(50, 200)"), 16);
});

test("a missing or invalid host measurement cannot pass", () => {
  for (const value of ["0", "-1", "NaN", "Infinity"]) {
    assert.throws(() => checker()(`cpuRate(${value}, 200)`), /calibration out of range/);
  }
});

test("calibration takes the median of seven samples in a fresh unthrottled page and closes it", async () => {
  const samples = [260, 245, 210, 200, 190, 180, 170];
  let calls = 0;
  let opened = 0;
  let closed = 0;
  const browser = {
    newPage: async () => {
      opened++;
      return { evaluate: async () => samples[calls++], close: async () => closed++ };
    },
  };
  const result = await checker({ browser })("calibrateCpu(browser)");
  assert.equal(opened, 1);
  assert.equal(calls, 7);
  assert.equal(closed, 1);
  assert.equal(result.hostMs, 200);
  assert.equal(result.rate, checker()("cpuRate(200)"));
});

test("calibration closes its page when the workload fails", async () => {
  let closed = false;
  const browser = { newPage: async () => ({ evaluate: async () => { throw new Error("workload failed"); }, close: async () => { closed = true; } }) };
  await assert.rejects(() => checker({ browser })("calibrateCpu(browser)"), /workload failed/);
  assert.equal(closed, true);
});

test("both builds share one calibration, including their warm loads", async () => {
  let calibrated = 0;
  const loads = [];
  const run = checker({ browser: {}, origin: "candidate", console: { log() {} }, calibrated: () => calibrated++, loads });
  run("calibrateCpu = async () => { calibrated(); return { hostMs: 260, rate: 3.08 }; }; baseBuild = async () => ({ at: 'base', name: 'origin/main' }); firstScreen = async (at, rate) => { loads.push({ at, rate }); return { ms: 1900, bytes: 100000, inPage: true }; };");
  const result = await run("firstScreenTurn()");
  assert.equal(calibrated, 1);
  assert.equal(loads.length, 16);
  assert.equal(loads.filter((load) => load.at === "base").length, 8);
  assert.ok(loads.every((load) => load.rate === 3.08));
  assert.equal(result.sides[0].ms.length, 7);
  assert.equal(result.sides[1].ms.length, 7);
});

test("a base archive without apps/web reports the reason before attempting a build", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-check-test-"));
  let built = false;
  const run = checker({
    fs: { ...fs, mkdtempSync: () => dir },
    spawnSync: (command) => {
      if (command === "git") return { status: 0, stdout: Buffer.alloc(0) };
      if (command === "tar") return { status: 0 };
      built = true;
      return { status: 1 };
    },
  });
  try {
    const result = await run("baseBuild()");
    assert.equal(result.why, "origin/main has no apps/web");
    assert.equal(built, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a nonempty but broken web-app archive is not treated as main having no web app", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-check-test-"));
  fs.writeFileSync(path.join(dir, "broken-app"), "present");
  const run = checker({
    fs: { ...fs, mkdtempSync: () => dir },
    spawnSync: (command) => command === "git" ? { status: 0, stdout: Buffer.alloc(0) } : { status: command === "tar" ? 0 : 1 },
  });
  try {
    const result = await run("baseBuild()");
    assert.equal(result.why, "origin/main did not build");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable base still applies and prints the absolute 2000 ms limit", () => {
  const run = checker();
  const result = (ms) => `({ sides: [{ name: 'this build', ms: [${Array(7).fill(ms)}], bytes: [100000], inPage: [true] }], why: 'git cannot read origin/main', before: '0.0', after: '0.0' })`;
  assert.equal(run(`judgeFirstScreen(${result(2000)}).length`), 0);
  assert.match(run(`judgeFirstScreen(${result(2001)})[0]`), /over 2000 ms.*git cannot read origin\/main/);
  assert.match(run(`firstScreenLines(${result(2001)}).join('\\n')`), /git cannot read origin\/main.*absolute 2000 ms limit applies/);
});

test("the first-screen and download limits keep their approved values", () => {
  assert.equal(checker()("JSON.stringify([FIRST_SCREEN_MS, FIRST_SCREEN_LOADS, FIRST_SCREEN_SLOWER_MS, FIRST_LOAD_BYTES, FIRST_LOAD_GROWTH_BYTES, SLOW_4G])"), JSON.stringify([2000, 7, 40, 122880, 1024, { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 }]));
});

test("an over-line median is carded rather than failed only when origin/main has no web app", () => {
  const run = checker();
  const result = "({ sides: [{ name: 'this build', ms: [2002, 2007, 2011, 2012, 2014, 2018, 2022], bytes: [100000], inPage: [true] }], why: 'origin/main has no apps/web', rate: 3.41, before: '0.0', after: '0.0' })";
  assert.equal(run(`judgeFirstScreen(${result}).length`), 0);
  assert.equal(run(`firstScreenLines(${result}).filter((line) => line.startsWith('CARD ')).join('\\n')`), "CARD first screen phone-390: 2012 ms measured against the 2000 ms line (median of 7 loads, spread 20 ms, CPU rate 3.41 calibrated to the reference). Main has no web app yet, so this miss is carded for the Captain, not failed.");
});

test("a median at or under the line without a web app on main has no CARD and keeps the usual report", () => {
  const run = checker();
  for (const ms of [1990, 2000]) {
    const result = `({ sides: [{ name: 'this build', ms: [${Array(7).fill(ms)}], bytes: [100000], inPage: [true] }], why: 'origin/main has no apps/web', rate: 4, before: '0.0', after: '0.0' })`;
    assert.equal(run(`judgeFirstScreen(${result}).length`), 0);
    assert.equal(run(`firstScreenLines(${result}).some((line) => line.startsWith('CARD '))`), false);
    assert.equal(run(`firstScreenLines(${result})[1]`), "design-check: no origin/main build to compare with (origin/main has no apps/web), so the absolute 2000 ms limit applies");
  }
});

test("other missing-base reasons still fail an over-line median and never card it", () => {
  const run = checker();
  for (const why of ["git cannot read origin/main", "origin/main did not unpack", "origin/main did not build", "origin/main did not start", "other has no apps/web"]) {
    const result = `({ sides: [{ name: 'this build', ms: [2012], bytes: [100000], inPage: [true] }], why: ${JSON.stringify(why)}, rate: 4, before: '0.0', after: '0.0' })`;
    assert.match(run(`judgeFirstScreen(${result})[0]`), /over 2000 ms/);
    assert.equal(run(`firstScreenLines(${result}).some((line) => line.startsWith('CARD '))`), false);
  }
});

test("carding a first-screen miss does not waive the download limit", () => {
  const result = "({ sides: [{ ms: [2012], bytes: [122881] }], why: 'origin/main has no apps/web' })";
  assert.match(checker()(`judgeFirstScreen(${result})[0]`), /downloaded 122881 bytes, over 122880/);
});

test("both calibration failures abort before reading the base or loading either build", async () => {
  for (const [hostMs, reason] of [[711, /host too slow to emulate/], [20, /calibration out of range/]]) {
    let closed = false;
    const browser = { newPage: async () => ({ evaluate: async () => hostMs, close: async () => { closed = true; } }) };
    const run = checker({ browser });
    run("baseBuild = async () => { throw new Error('must not read base'); }; firstScreen = async () => { throw new Error('must not load'); };");
    await assert.rejects(() => run("firstScreenTurn()"), reason);
    assert.equal(closed, true);
  }
});

test("with a base the relative time and byte margins are unchanged even above 2000 ms", () => {
  const run = checker();
  const result = (ms, bytes = 100000) => `({ sides: [{ ms: [${Array(7).fill(ms)}], bytes: [${bytes}], inPage: [true] }, { name: 'origin/main', ms: [${Array(7).fill(2080)}], bytes: [100000], inPage: [true] }], rate: 4, before: '0.0', after: '0.0' })`;
  assert.equal(run(`judgeFirstScreen(${result(2120)}).length`), 0);
  assert.match(run(`judgeFirstScreen(${result(2121)})[0]`), /41 ms slower/);
  assert.equal(run(`judgeFirstScreen(${result(2100, 101024)}).length`), 0);
  assert.match(run(`judgeFirstScreen(${result(2100, 101025)})[0]`), /downloads 1025 bytes more/);
  assert.equal(run(`firstScreenLines(${result(2100)}).some((line) => line.startsWith('CARD '))`), false);
});
