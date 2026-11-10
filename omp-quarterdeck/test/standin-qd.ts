#!/usr/bin/env bun
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

type Response = {
  exitCode?: number;
  holdAfterMs?: number;
  holdMs?: number;
  ignoreTerm?: boolean;
  messages?: unknown[];
  raw?: string;
  stderr?: string;
};

type Scenario = {
  responses: Response[];
  statePath: string;
  stoppedPath?: string;
  envPath?: string;
  mailbox?: unknown[];
  pipeClosedPath?: string;
};

type State = {
  calls: number;
  invocations: Array<{ argv: string[]; at: number; pid: number }>;
};

const configIndex = process.argv.indexOf("--config");
if (configIndex < 0 || !process.argv[configIndex + 1]) process.exit(64);

const loadScenario = () => JSON.parse(readFileSync(process.argv[configIndex + 1], "utf8")) as Scenario;
const scenario = loadScenario();
let state: State = { calls: 0, invocations: [] };
try {
  state = JSON.parse(readFileSync(scenario.statePath, "utf8")) as State;
} catch (error) {
  const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  if (!missing) throw error;
}

const callIndex = state.calls;
state.calls += 1;
state.invocations.push({ argv: process.argv.slice(2), at: Date.now(), pid: process.pid });
const writeAtomic = (path: string, text: string) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
};
if (scenario.envPath) writeAtomic(scenario.envPath, JSON.stringify(Object.keys(process.env).sort()));
writeAtomic(scenario.statePath, JSON.stringify(state));

const response = scenario.responses[Math.min(callIndex, scenario.responses.length - 1)] ?? { holdMs: 300_000 };
const markStopped = () => {
  if (scenario.stoppedPath) appendFileSync(scenario.stoppedPath, `${process.pid}\n`, { mode: 0o600 });
};
process.on("SIGTERM", () => {
  markStopped();
  if (!response.ignoreTerm) process.exit(0);
});
process.on("SIGINT", () => {
  markStopped();
  process.exit(0);
});
const markPipeClosed = () => {
  if (scenario.pipeClosedPath) appendFileSync(scenario.pipeClosedPath, `${process.pid}\n`, { mode: 0o600 });
  process.exit(32);
};
process.stdout.on("error", markPipeClosed);
const writeOut = (text: string) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  process.stdout.write(text, (error) => (error ? markPipeClosed() : resolve()));
  return promise;
};
const writeChunks = async (text: string) => {
  for (let at = 0; at < text.length; at += 32_768) await writeOut(text.slice(at, at + 32_768));
};
const argumentAfter = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const serveMailbox = async () => {
  const after = argumentAfter("--after");
  const longPoll = argumentAfter("--timeout") !== "0";
  const deadline = Date.now() + 300_000;
  while (true) {
    const mailbox = loadScenario().mailbox ?? [];
    const start = after === undefined ? 0 : mailbox.findIndex((message) => typeof message === "object" && message !== null && "id" in message && message.id === after) + 1;
    const selected = mailbox.slice(start);
    if (selected.length > 0 || !longPoll || Date.now() >= deadline) {
      await writeChunks(selected.map((message) => `${JSON.stringify(message)}\n`).join(""));
      process.exit(0);
    }
    await Bun.sleep(20);
  }
};
if (scenario.mailbox) await serveMailbox();
if (response.ignoreTerm) setTimeout(() => process.exit(33), response.holdAfterMs ?? 3_000);

if (response.stderr) process.stderr.write(response.stderr);
if (response.holdMs) await Bun.sleep(response.holdMs);
for (const message of response.messages ?? []) process.stdout.write(`${JSON.stringify(message)}\n`);
if (response.raw) await writeChunks(response.raw);
if (response.holdAfterMs) await Bun.sleep(response.holdAfterMs);
process.exit(response.exitCode ?? 0);
