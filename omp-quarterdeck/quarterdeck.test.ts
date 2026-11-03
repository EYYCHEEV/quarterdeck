import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAIL_NOTIFICATION_METHOD,
  createQuarterdeckExtension,
  type ExtensionApi,
  type ExtensionContext,
  type QuarterdeckConfig,
  type RetryPolicy,
} from "./quarterdeck";

type Handler = (event: unknown, context: ExtensionContext) => unknown;
type SentMessage = {
  message: { customType: string; content: string; display: boolean };
  options: { deliverAs: "followUp"; triggerTurn: true };
};

class FakeContext implements ExtensionContext {
  private nextTimer = 0;
  private readonly cancelTimers = new Map<number, () => void>();
  readonly scheduledDelays: number[] = [];

  setTimeout(callback: () => void, delay: number) {
    this.scheduledDelays.push(delay);
    const handle = ++this.nextTimer;
    const timer = setTimeout(() => {
      this.cancelTimers.delete(handle);
      callback();
    }, delay);
    this.cancelTimers.set(handle, () => clearTimeout(timer));
    return handle;
  }

  clearTimer(handle: unknown) {
    if (typeof handle !== "number") return;
    this.cancelTimers.get(handle)?.();
    this.cancelTimers.delete(handle);
  }

  clearAll() {
    for (const cancel of this.cancelTimers.values()) cancel();
    this.cancelTimers.clear();
  }
}

class FakePi implements ExtensionApi {
  readonly context = new FakeContext();
  readonly sent: SentMessage[] = [];
  readonly handlers = new Map<string, Handler[]>();
  busy = false;
  startedTurns = 0;
  queuedFollowUps = 0;

  on(name: string, handler: Handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
    this.sent.push({ message, options });
    if (this.busy) this.queuedFollowUps += 1;
    else if (options.triggerTurn) this.startedTurns += 1;
  }

  async emit(name: string, event: unknown = {}) {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, this.context);
  }

  async shutdown() {
    await this.emit("session_shutdown");
    this.context.clearAll();
  }
}

type StandinResponse = {
  exitCode?: number;
  holdMs?: number;
  messages?: unknown[];
  stderr?: string;
};

type Harness = {
  bot: string;
  root: string;
  config: QuarterdeckConfig;
  pi: FakePi;
  scenarioPath: string;
  statePath: string;
  stoppedPath: string;
};

type SharedHarness = Pick<Harness, "bot" | "root" | "config" | "scenarioPath" | "statePath" | "stoppedPath">;

type HarnessOptions = {
  bot?: string;
  shared?: SharedHarness;
};

const roots: string[] = [];
const sessions: FakePi[] = [];
const standinSource = join(import.meta.dir, "test", "standin-qd.ts");

async function makeHarness(responses: StandinResponse[], options: HarnessOptions = {}): Promise<Harness> {
  const shared = options.shared;
  if (shared) {
    const pi = new FakePi();
    sessions.push(pi);
    return { ...shared, pi };
  }

  const bot = options.bot ?? "bot-a";
  const root = await mkdtemp(join(tmpdir(), "quarterdeck-wake-"));
  roots.push(root);
  const qdExecutable = join(root, "qd.py");
  const scenarioPath = join(root, "bot-config.json");
  const statePath = join(root, "standin-state.json");
  const stoppedPath = join(root, "stopped.txt");
  const cursorRoot = join(root, "quarterdeck-config");
  await copyFile(standinSource, qdExecutable);
  await chmod(qdExecutable, 0o700);
  await mkdir(cursorRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    scenarioPath,
    JSON.stringify({ adapter: { bot }, responses, statePath, stoppedPath, envPath: join(root, "qd-env.json") }),
    { mode: 0o600 },
  );

  const config: QuarterdeckConfig = {
    botConfigPath: scenarioPath,
    cursorRoot,
    mcpServer: "quarterdeck",
    qdExecutable,
    waitTimeoutSeconds: 300,
  };
  const pi = new FakePi();
  sessions.push(pi);
  return { bot, root, config, pi, scenarioPath, statePath, stoppedPath };
}

function install(
  harness: Harness,
  retry: RetryPolicy = { initialMs: 40, maximumMs: 80 },
  reconcileIntervalMs?: number,
) {
  createQuarterdeckExtension({ config: harness.config, retry, reconcileIntervalMs })(harness.pi);
}

async function readState(harness: Harness) {
  try {
    return JSON.parse(await readFile(harness.statePath, "utf8")) as {
      calls: number;
      invocations: Array<{ argv: string[]; at: number }>;
    };
  } catch (error) {
    if (hasErrno(error, "ENOENT")) return { calls: 0, invocations: [] };
    throw error;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await Bun.sleep(5);
  }
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function hasErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function mail(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sender: "other-bot",
    subject: "status update",
    body: "body must not enter the wake",
    ...overrides,
  };
}

const realExecPath = process.execPath;

async function makeRuntimeStandin(root: string) {
  const path = join(root, "runtime-standin");
  await writeFile(
    path,
    [
      `#!${realExecPath}`,
      `import { readlinkSync, writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(join(root, "runtime-env.json"))}, JSON.stringify(Object.keys(process.env).sort()));`,
      `writeFileSync(${JSON.stringify(join(root, "runtime-stdin.txt"))}, readlinkSync("/proc/self/fd/0"));`,
      `if (process.env.BUN_BE_BUN !== "1") process.exit(3);`,
      `await import(process.argv[2]);`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return path;
}

async function withExecPath<T>(runtime: string, action: () => Promise<T>) {
  process.execPath = runtime;
  try {
    return await action();
  } finally {
    process.execPath = realExecPath;
  }
}

async function runHolder(runtime: string, holderPath: string, extra: Record<string, string>) {
  const child = Bun.spawn([runtime, holderPath], {
    env: { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const exitCode = await Promise.race([child.exited, Bun.sleep(500).then(() => undefined)]);
  if (exitCode === undefined) child.kill("SIGTERM");
  await child.exited;
  return { exitCode, stdout: await new Response(child.stdout).text() };
}

const realHolderPath = join(import.meta.dir, "lock-holder.ts");
const CLOCK_TICKS_PER_SECOND = 100;

async function cpuSeconds(pid: number) {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS_PER_SECOND;
}

async function processGone(pid: number) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2, text.lastIndexOf(")") + 3) === "Z";
  } catch {
    return true;
  }
}

async function startHolder(command: string[] = [realExecPath, realHolderPath]) {
  const child = Bun.spawn(command, {
    env: { HOME: process.env.HOME ?? "/", PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toBe("locked\n");
  return child;
}

async function exitWithin(child: { exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void }, ms: number) {
  const result = await Promise.race([child.exited, Bun.sleep(ms).then(() => undefined)]);
  if (result === undefined) child.kill("SIGKILL");
  await child.exited;
  return result;
}

async function flockExit(lockPath: string) {
  const probe = Bun.spawn(["flock", "--exclusive", "--nonblock", "--conflict-exit-code", "75", lockPath, "true"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exited;
}

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Quarterdeck OMP wake extension", () => {
  test("takes bot-a only from the configured client file", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    (harness.config as QuarterdeckConfig & { bot?: string }).bot = "bot-b";
    const previousBot = process.env.QUARTERDECK_BOT;
    process.env.QUARTERDECK_BOT = "bot-b";
    install(harness);

    try {
      await harness.pi.emit("session_start");
      await waitFor(async () => (await readState(harness)).calls >= 1);
      const configuredDirectory = join(harness.config.cursorRoot, "bot-a");
      expect(await fileExists(join(configuredDirectory, "wake-poller.lock"))).toBe(true);
      expect(await fileExists(join(harness.config.cursorRoot, "bot-b", "wake-poller.lock"))).toBe(false);
    } finally {
      if (previousBot === undefined) delete process.env.QUARTERDECK_BOT;
      else process.env.QUARTERDECK_BOT = previousBot;
    }
  });

  test("a fourth new bot polls from its configured identity without code changes", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }], { bot: "bot-four" });
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(async () => (await readState(harness)).calls >= 1);

    expect(await fileExists(join(harness.config.cursorRoot, "bot-four", "wake-poller.lock"))).toBe(true);
    expect(await fileExists(join(harness.config.cursorRoot, "bot-a"))).toBe(false);
    expect(await fileExists(join(harness.config.cursorRoot, "bot-b"))).toBe(false);
  });

  test("has no default client config when QUARTERDECK_CONFIG is missing", () => {
    const previousConfig = process.env.QUARTERDECK_CONFIG;
    delete process.env.QUARTERDECK_CONFIG;
    try {
      expect(() => createQuarterdeckExtension()(new FakePi())).toThrow("QUARTERDECK_CONFIG is required");
    } finally {
      if (previousConfig === undefined) delete process.env.QUARTERDECK_CONFIG;
      else process.env.QUARTERDECK_CONFIG = previousConfig;
    }
  });

  test("refuses to start when the configured client file is missing", async () => {
    const harness = await makeHarness([]);
    await rm(harness.scenarioPath);
    install(harness);

    await expect(harness.pi.emit("session_start")).rejects.toThrow("client configuration is invalid");
    expect((await readState(harness)).calls).toBe(0);
    expect(await fileExists(join(harness.config.cursorRoot, "bot-a"))).toBe(false);
  });

  test("refuses a client config without a valid bot instead of using a process fallback", async () => {
    const harness = await makeHarness([]);
    const scenario = JSON.parse(await readFile(harness.scenarioPath, "utf8")) as Record<string, unknown>;
    scenario.adapter = {};
    await writeFile(harness.scenarioPath, JSON.stringify(scenario), { mode: 0o600 });
    const previousBot = process.env.QUARTERDECK_BOT;
    process.env.QUARTERDECK_BOT = "bot-b";
    install(harness);

    try {
      await expect(harness.pi.emit("session_start")).rejects.toThrow("has no bot identity");
      expect((await readState(harness)).calls).toBe(0);
      expect(await fileExists(join(harness.config.cursorRoot, "bot-b"))).toBe(false);
    } finally {
      if (previousBot === undefined) delete process.env.QUARTERDECK_BOT;
      else process.env.QUARTERDECK_BOT = previousBot;
    }
  });

  test("an idle session gets one follow-up turn for one mail batch", async () => {
    const harness = await makeHarness([
      { messages: [mail("m-1"), mail("m-2")] },
      { holdMs: 10_000 },
    ]);
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(() => harness.pi.sent.length === 1);

    expect(harness.pi.startedTurns).toBe(1);
    expect(harness.pi.queuedFollowUps).toBe(0);
    expect(harness.pi.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(harness.pi.sent[0].message.customType).toBe("quarterdeck.mail");
    expect(harness.pi.sent[0].message.display).toBe(true);
    expect(harness.pi.sent[0].message.content.split("\n")).toHaveLength(2);
  });

  test("a busy session queues the mail batch behind the current run", async () => {
    const harness = await makeHarness(
      [{ messages: [mail("busy-1")] }, { holdMs: 10_000 }],
      { bot: "bot-b" },
    );
    harness.pi.busy = true;
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(() => harness.pi.sent.length === 1);

    expect(harness.pi.startedTurns).toBe(0);
    expect(harness.pi.queuedFollowUps).toBe(1);
    expect(harness.pi.sent[0].options.deliverAs).toBe("followUp");
  });

  test("duplicate message ids are delivered once across and within batches", async () => {
    const harness = await makeHarness([
      { messages: [mail("same"), mail("same")] },
      { messages: [mail("same"), mail("new")] },
      { holdMs: 10_000 },
    ]);
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(() => harness.pi.sent.length === 2);

    expect(harness.pi.sent[0].message.content.match(/id=same/g)).toHaveLength(1);
    expect(harness.pi.sent[1].message.content).not.toContain("id=same");
    expect(harness.pi.sent[1].message.content).toContain("id=new");
  });

  test("cursor is mode 0600, persists after delivery, and drives the next wait", async () => {
    const harness = await makeHarness([
      { messages: [] },
      { messages: [mail("cursor-id")] },
      { holdMs: 10_000 },
    ]);
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(async () => (await readState(harness)).calls >= 3);

    const cursorPath = join(harness.config.cursorRoot, harness.bot, "wake.cursor");
    expect((await stat(cursorPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(cursorPath, "utf8")).trim()).toBe("cursor-id");
    const state = await readState(harness);
    expect(state.invocations[2].argv).toEqual([
      "--config", harness.scenarioPath, "wait", "--after", "cursor-id", "--timeout", "300",
    ]);
    expect(state.invocations.flatMap((call) => call.argv)).not.toContain("ack");
  });

  test("unhandled mail gets one reminder after ten minutes without a reminder storm", async () => {
    const reconcileIntervalMs = 80;
    const harness = await makeHarness([
      { messages: [mail("unacked-id")] },
      { holdMs: reconcileIntervalMs + 20 },
      { messages: [mail("unacked-id"), mail("unacked-id")] },
      { holdMs: 10_000 },
    ]);
    install(harness, { initialMs: 20, maximumMs: 40, successMs: 5 }, reconcileIntervalMs);

    await harness.pi.emit("session_start");
    await waitFor(() => harness.pi.sent.length === 2);

    expect(harness.pi.sent[0].message.content).toContain("id=unacked-id");
    expect(harness.pi.sent[1].message.content).toContain("1 Quarterdeck mail still unhandled");
    expect(harness.pi.sent[1].message.content).toContain("id=unacked-id");
    expect(harness.pi.sent[1].message.content.match(/id=unacked-id/g)).toHaveLength(1);
    expect(harness.pi.sent[1].message.content).not.toContain("body=");
    expect((await readState(harness)).invocations[0].argv).toEqual([
      "--config", harness.scenarioPath, "wait", "--timeout", "0",
    ]);
    await Bun.sleep(reconcileIntervalMs / 2);
    expect(harness.pi.sent).toHaveLength(2);
  });

  test("acknowledged mail receives no reminder", async () => {
    const reconcileIntervalMs = 80;
    const harness = await makeHarness([
      { messages: [mail("acked-id")] },
      { holdMs: reconcileIntervalMs + 20 },
      { messages: [] },
      { holdMs: 10_000 },
    ]);
    install(harness, { initialMs: 20, maximumMs: 40, successMs: 5 }, reconcileIntervalMs);

    await harness.pi.emit("session_start");
    await waitFor(async () => (await readState(harness)).calls >= 4);
    await Bun.sleep(20);

    expect(harness.pi.sent).toHaveLength(1);
    expect(harness.pi.sent[0].message.content).toContain("id=acked-id");
  });

  test("session start wakes old unhandled mail once without moving the stored cursor", async () => {
    const harness = await makeHarness([
      { messages: [mail("old-unhandled-id")] },
      { holdMs: 10_000 },
    ]);
    const botDirectory = join(harness.config.cursorRoot, harness.bot);
    await mkdir(botDirectory, { recursive: true, mode: 0o700 });
    const cursorPath = join(botDirectory, "wake.cursor");
    await writeFile(cursorPath, "stored-cursor\n", { mode: 0o600 });
    install(harness, { initialMs: 20, maximumMs: 40, successMs: 5 }, 80);

    await harness.pi.emit("session_start");
    await waitFor(async () => harness.pi.sent.length === 1 && (await readState(harness)).calls >= 2);

    expect(harness.pi.sent[0].message.content).toContain("id=old-unhandled-id");
    expect((await readFile(cursorPath, "utf8")).trim()).toBe("stored-cursor");
    const state = await readState(harness);
    expect(state.invocations[0].argv).toEqual([
      "--config", harness.scenarioPath, "wait", "--timeout", "0",
    ]);
    expect(state.invocations[1].argv).toEqual([
      "--config", harness.scenarioPath, "wait", "--after", "stored-cursor", "--timeout", "300",
    ]);
    await Bun.sleep(20);
    expect(harness.pi.sent).toHaveLength(1);
  });

  test("an empty qd.py wait re-waits on the success interval without error backoff", async () => {
    const harness = await makeHarness([
      { messages: [] },
      { messages: [] },
      { messages: [] },
      { holdMs: 10_000 },
    ]);
    install(harness, { initialMs: 120, maximumMs: 240, successMs: 20 }, 1_000);

    await harness.pi.emit("session_start");
    await waitFor(async () => (await readState(harness)).calls >= 4);

    expect(harness.pi.context.scheduledDelays.slice(0, 3)).toEqual([0, 20, 20]);
  });

  test("a held bot lock lets exactly one same-bot session poll", async () => {
    const first = await makeHarness([{ holdMs: 10_000 }]);
    const second = await makeHarness([], { shared: first });
    install(first);
    install(second);

    await first.pi.emit("session_start");
    await waitFor(async () => (await readState(first)).calls === 1);
    await second.pi.emit("session_start");
    expect((await readState(first)).calls).toBe(1);

    const lockPath = join(first.config.cursorRoot, first.bot, "wake-poller.lock");
    expect(await fileExists(lockPath)).toBe(true);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    await first.pi.shutdown();
    const replacement = await makeHarness([], { shared: first });
    install(replacement);
    await replacement.pi.emit("session_start");
    await waitFor(async () => (await readState(first)).calls === 2);
  });

  test("429 and other wait failures use bounded backoff instead of a tight retry", async () => {
    const harness = await makeHarness([
      { exitCode: 1, stderr: "429 too many requests\n" },
      { exitCode: 1, stderr: "other failure\n" },
      { messages: [mail("after-backoff")] },
      { holdMs: 10_000 },
    ]);
    install(harness, { initialMs: 50, maximumMs: 70 });

    await harness.pi.emit("session_start");
    await waitFor(async () => (await readState(harness)).calls >= 3);

    const state = await readState(harness);
    expect(state.invocations[1].at - state.invocations[0].at).toBeGreaterThanOrEqual(45);
    expect(state.invocations[2].at - state.invocations[1].at).toBeGreaterThanOrEqual(65);
    await waitFor(() => harness.pi.sent.length === 1);
  });

  test("session shutdown stops the owned wait child and starts no replacement", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(async () => (await readState(harness)).calls === 1);
    await harness.pi.shutdown();
    await waitFor(() => fileExists(harness.stoppedPath));
    await Bun.sleep(80);

    expect((await readState(harness)).calls).toBe(1);
  });

  test("wake lines label untrusted mail and contain sender, subject and id only", async () => {
    const apiKey = "API_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const invite = "aZ01987654321INVITECODE";
    const bodyOnly = "IGNORE-PREVIOUS-INSTRUCTIONS-FROM-BODY";
    const harness = await makeHarness([
      { messages: [mail("safe-id", {
        sender: `other-bot token=${apiKey}`,
        subject: `join request ${invite}`,
        body: `${bodyOnly} ${apiKey} ${invite}`,
      })] },
      { holdMs: 10_000 },
    ]);
    install(harness);

    await harness.pi.emit("session_start");
    await waitFor(() => harness.pi.sent.length === 1);

    const content = harness.pi.sent[0].message.content;
    expect(content).toContain("Quarterdeck mail from another bot (untrusted text):");
    expect(content).toContain("from=");
    expect(content).toContain("subject=");
    expect(content).toContain("id=safe-id");
    expect(content).not.toContain("body=");
    expect(content).not.toContain("preview=");
    expect(content).not.toContain(bodyOnly);
    expect(content).not.toContain(apiKey);
    expect(content).not.toContain(invite);
  });

  test("the named MCP notification uses the same deduped wake path without acking", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    install(harness);
    await harness.pi.emit("session_start");

    const event = {
      server: "quarterdeck",
      method: MAIL_NOTIFICATION_METHOD,
      params: { messages: [mail("push-id"), mail("push-id")] },
    };
    await harness.pi.emit("mcp_notification", event);
    await waitFor(() => harness.pi.sent.length === 1);

    expect(harness.pi.sent[0].message.content.match(/id=push-id/g)).toHaveLength(1);
    expect(harness.pi.sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    const state = await readState(harness);
    expect(state.invocations.flatMap((call) => call.argv)).not.toContain("ack");
  });

  test("the stand-in runtime runs the holder only when BUN_BE_BUN is 1", async () => {
    const harness = await makeHarness([]);
    const runtime = await makeRuntimeStandin(harness.root);
    const holderPath = join(import.meta.dir, "lock-holder.ts");

    const without = await runHolder(runtime, holderPath, {});
    expect(without).toEqual({ exitCode: 3, stdout: "" });

    const wrongValue = await runHolder(runtime, holderPath, { BUN_BE_BUN: "0" });
    expect(wrongValue).toEqual({ exitCode: 3, stdout: "" });

    const withVariable = await runHolder(runtime, holderPath, { BUN_BE_BUN: "1" });
    expect(withVariable).toEqual({ exitCode: undefined, stdout: "locked\n" });
  });

  test("the lock holder starts under a runtime that is bun only with BUN_BE_BUN set to 1", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    const runtime = await makeRuntimeStandin(harness.root);
    install(harness);

    await withExecPath(runtime, () => harness.pi.emit("session_start"));

    await waitFor(async () => (await readState(harness)).calls === 1);
    expect(await fileExists(join(harness.config.cursorRoot, harness.bot, "wake-poller.lock"))).toBe(true);
  });

  test("a runtime that never acts as bun starts no poller and the session stays alive", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    const never = join(harness.root, "runtime-never");
    await writeFile(never, "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    install(harness);

    await withExecPath(never, () => harness.pi.emit("session_start"));
    await Bun.sleep(200);

    expect((await readState(harness)).calls).toBe(0);
  });

  test("only the lock holder gets BUN_BE_BUN and the wait child keeps the safe environment", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    const runtime = await makeRuntimeStandin(harness.root);
    install(harness);

    await withExecPath(runtime, () => harness.pi.emit("session_start"));
    await waitFor(async () => (await readState(harness)).calls === 1);

    const safe = ["HOME", "LANG", "LC_ALL", "PATH", ...(process.env.XDG_CONFIG_HOME ? ["XDG_CONFIG_HOME"] : [])].sort();
    const waitNames = JSON.parse(await readFile(join(harness.root, "qd-env.json"), "utf8")) as string[];
    const holderNames = JSON.parse(await readFile(join(harness.root, "runtime-env.json"), "utf8")) as string[];
    expect(waitNames).toEqual(safe);
    expect(holderNames).toEqual([...safe, "BUN_BE_BUN"].sort());
  });

  test("the lock holder uses under 5 percent of one core while it holds the lock", async () => {
    const child = await startHolder();
    try {
      const before = await cpuSeconds(child.pid);
      const started = performance.now();
      await Bun.sleep(3_000);
      const used = (await cpuSeconds(child.pid)) - before;
      const elapsed = (performance.now() - started) / 1000;
      expect(used / elapsed).toBeLessThan(0.05);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 15_000);

  test("the lock holder exits by itself when its stdin reaches end of file", async () => {
    const child = await startHolder();
    child.stdin.end();

    expect(await exitWithin(child, 3_000)).toBe(0);
  }, 15_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} still stops the lock holder and frees the lock`, async () => {
      const harness = await makeHarness([]);
      const lockPath = join(harness.root, "holder.lock");
      const child = await startHolder([
        "flock",
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "75",
        "--no-fork",
        lockPath,
        realExecPath,
        realHolderPath,
      ]);
      expect(await flockExit(lockPath)).toBe(75);

      child.kill(signal);

      expect(await exitWithin(child, 3_000)).toBe(0);
      expect(await flockExit(lockPath)).toBe(0);
    }, 15_000);
  }

  test("the extension starts the lock holder with an open stream on stdin, not the null device", async () => {
    const harness = await makeHarness([{ holdMs: 10_000 }]);
    const runtime = await makeRuntimeStandin(harness.root);
    install(harness);

    await withExecPath(runtime, () => harness.pi.emit("session_start"));
    await waitFor(async () => (await readState(harness)).calls === 1);

    expect(await readFile(join(harness.root, "runtime-stdin.txt"), "utf8")).toMatch(/^(pipe|socket):\[\d+\]$/);
  });

  test("an orphaned lock holder exits after its parent is killed", async () => {
    const harness = await makeHarness([]);
    const parentPath = join(harness.root, "parent.ts");
    await writeFile(
      parentPath,
      [
        `const holder = Bun.spawn([process.execPath, ${JSON.stringify(realHolderPath)}], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });`,
        `await holder.stdout.getReader().read();`,
        `process.stdout.write(String(holder.pid) + "\\n");`,
        `setInterval(() => {}, 1000);`,
        "",
      ].join("\n"),
    );
    const parent = Bun.spawn([realExecPath, parentPath], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reader = parent.stdout.getReader();
    const holderPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    expect(await processGone(holderPid)).toBe(false);

    parent.kill("SIGKILL");
    await parent.exited;

    try {
      await waitFor(() => processGone(holderPid), 3_000);
    } finally {
      if (!(await processGone(holderPid))) process.kill(holderPid, "SIGKILL");
    }
  }, 20_000);
});
