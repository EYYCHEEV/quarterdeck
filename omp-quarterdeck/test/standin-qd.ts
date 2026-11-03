#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

type Response = {
  exitCode?: number;
  holdMs?: number;
  messages?: unknown[];
  stderr?: string;
};

type Scenario = {
  responses: Response[];
  statePath: string;
  stoppedPath?: string;
  envPath?: string;
};

type State = {
  calls: number;
  invocations: Array<{ argv: string[]; at: number }>;
};

const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) process.exit(64);

const scenario = JSON.parse(readFileSync(process.argv[configIndex + 1], "utf8")) as Scenario;
let state: State = { calls: 0, invocations: [] };
try {
  state = JSON.parse(readFileSync(scenario.statePath, "utf8")) as State;
} catch (error) {
  const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  if (!missing) throw error;
}

const callIndex = state.calls;
state.calls += 1;
state.invocations.push({ argv: process.argv.slice(2), at: Date.now() });
writeFileSync(scenario.statePath, JSON.stringify(state), { mode: 0o600 });
if (scenario.envPath) writeFileSync(scenario.envPath, JSON.stringify(Object.keys(process.env).sort()), { mode: 0o600 });

const response = scenario.responses[Math.min(callIndex, scenario.responses.length - 1)] ?? { holdMs: 300_000 };
const markStopped = () => {
  if (scenario.stoppedPath) appendFileSync(scenario.stoppedPath, `${process.pid}\n`, { mode: 0o600 });
};
process.on("SIGTERM", () => {
  markStopped();
  process.exit(0);
});
process.on("SIGINT", () => {
  markStopped();
  process.exit(0);
});

if (response.stderr) process.stderr.write(response.stderr);
if (response.holdMs) await Bun.sleep(response.holdMs);
for (const message of response.messages ?? []) process.stdout.write(`${JSON.stringify(message)}\n`);
process.exit(response.exitCode ?? 0);
