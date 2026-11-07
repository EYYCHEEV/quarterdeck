import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MAIL_NOTIFICATION_METHOD = "notifications/quarterdeck/mail";

const CUSTOM_MESSAGE_TYPE = "quarterdeck.mail";
const CURSOR_FILE = "wake.cursor";
const LOCK_FILE = "wake-poller.lock";
const MAX_BATCH_MESSAGES = 1_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const SEEN_MESSAGE_IDS = 2_048;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1_000;
const NOTICE_INTERVAL_MS = 120_000;
const MAX_PENDING_IDS = 1000;

export interface QuarterdeckConfig {
  botConfigPath: string;
  cursorRoot: string;
  mcpServer: string;
  qdExecutable: string;
  waitTimeoutSeconds: 300;
}

export interface RetryPolicy {
  initialMs: number;
  maximumMs: number;
  successMs?: number;
}

export interface ExtensionContext {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
  agent?: { kind: "main" | "sub" };
}

export interface ExtensionApi {
  on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: "aside"; triggerTurn: true },
  ): void;
  sendMessageWithReceipt?(
    message: Parameters<ExtensionApi["sendMessage"]>[0],
    options: Parameters<ExtensionApi["sendMessage"]>[1],
  ): Promise<{ admitted: boolean }>;
}

export interface QuarterdeckExtensionOptions {
  config?: QuarterdeckConfig;
  retry?: RetryPolicy;
  flockExecutable?: string;
  lockHolderPath?: string;
  reconcileIntervalMs?: number;
}

type MailMessage = {
  id: string;
  sender: string;
  subject: string;
};

type McpNotification = {
  server: string;
  method: string;
  params: unknown;
};

type WakeRecord = {
  remindedAt?: number;
  wokenAt: number;
};

type WakeMessage = Parameters<ExtensionApi["sendMessage"]>[0];

const DEFAULT_RETRY: RetryPolicy = {
  initialMs: 1_000,
  maximumMs: 60_000,
  successMs: 250,
};

export function createQuarterdeckExtension(options: QuarterdeckExtensionOptions = {}) {
  return (pi: ExtensionApi) => {
    const config = options.config ?? configFromEnvironment();
    const retry = normalizeRetry(options.retry ?? DEFAULT_RETRY);
    const reconcileIntervalMs = normalizeReconcileInterval(options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
    const flockExecutable = options.flockExecutable ?? "flock";
    const lockHolderPath = options.lockHolderPath ?? join(import.meta.dir, "lock-holder.ts");
    let session: WakeSession | undefined;
    let subagent = false;
    const pendingNotifications = new Set<string>();

    pi.on("mcp_notification", async (event, context) => {
      if (subagent || context.agent?.kind === "sub") return;
      const notification = parseNotification(event);
      if (!notification || notification.server !== config.mcpServer || notification.method !== MAIL_NOTIFICATION_METHOD) return;
      const messages = parseNotificationMessages(notification.params);
      if (messages.length === 0) return;
      if (!session) {
        for (const id of messages) {
          if (!retainPendingId(pendingNotifications, id)) break;
        }
        return;
      }
      await session.deliver(messages).catch(() => undefined);
    });

    pi.on("session_start", async (_event, context) => {
      subagent = context.agent?.kind === "sub";
      if (subagent) {
        pendingNotifications.clear();
        return;
      }
      if (session) return;
      const bot = await readConfiguredBot(config.botConfigPath);
      const botDirectory = join(config.cursorRoot, bot);
      await ensurePrivateDirectory(botDirectory);
      const cursorStore = new CursorStore(join(botDirectory, CURSOR_FILE));
      const lease = await PollerLease.acquire({
        flockExecutable,
        holderPath: lockHolderPath,
        lockPath: join(botDirectory, LOCK_FILE),
      });
      const current = new WakeSession({ config, context, cursorStore, lease, pi, reconcileIntervalMs, retry, pendingIds: pendingNotifications });
      session = current;
      try {
        await current.start();
        await current.deliver([]).catch(() => undefined);
      } catch (error) {
        session = undefined;
        await current.stop();
        throw error;
      }
    });

    pi.on("session_shutdown", async () => {
      const current = session;
      session = undefined;
      await current?.stop();
    });
  };
}

class WakeSession {
  private backoffMs: number;
  private cursor: string | undefined;
  private deliveryTail: Promise<void> = Promise.resolve();
  private readonly seenOrder: string[] = [];
  private readonly wakeRecords = new Map<string, WakeRecord>();
  private readonly pendingFresh: Set<string>;
  private readonly pendingReminders = new Set<string>();
  private pendingCursor: string | undefined;
  private lastNoticeAt = Number.NEGATIVE_INFINITY;
  private noticeTimer: unknown;
  private nextReconcileAt = 0;
  private stopped = false;
  private pollerLost = false;
  private timer: unknown;
  private readonly waiter: QdCliWaiter | undefined;

  constructor(private readonly state: {
    config: QuarterdeckConfig;
    context: ExtensionContext;
    cursorStore: CursorStore;
    lease: PollerLease | undefined;
    pi: ExtensionApi;
    retry: RetryPolicy;
    reconcileIntervalMs: number;
    pendingIds: Set<string>;
  }) {
    this.backoffMs = state.retry.initialMs;
    this.pendingFresh = state.pendingIds;
    this.waiter = state.lease ? new QdCliWaiter(state.config) : undefined;
    state.lease?.onLoss(() => this.stopPolling());
  }

  async start() {
    this.cursor = await this.state.cursorStore.read();
    if (this.waiter) this.schedule(0);
  }

  deliver(ids: string[], advanceCursor = false) {
    this.addToNotice(ids, advanceCursor);
    return this.queueDelivery(() => this.flushNotice());
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) this.state.context.clearTimer(this.timer);
    this.timer = undefined;
    if (this.noticeTimer !== undefined) this.state.context.clearTimer(this.noticeTimer);
    this.noticeTimer = undefined;
    await this.waiter?.stop();
    await this.state.lease?.release();
    await this.deliveryTail.catch(() => undefined);
  }

  private schedule(delay: number) {
    if (this.stopped || this.pollerLost || !this.waiter) return;
    this.timer = this.state.context.setTimeout(() => {
      this.timer = undefined;
      void this.pollOnce().catch(() => undefined);
    }, delay);
  }

  private async pollOnce() {
    if (this.stopped || this.pollerLost || !this.waiter) return;
    try {
      if (Date.now() >= this.nextReconcileAt) await this.reconcile();
      if (this.stopped || this.pollerLost) return;
      const messages = await this.waiter.wait(this.cursor);
      if (this.stopped || this.pollerLost) return;
      await this.deliver(messages.map((message) => message.id), true);
      this.backoffMs = this.state.retry.initialMs;
      this.schedule(this.state.retry.successMs ?? 250);
    } catch {
      if (this.stopped || this.pollerLost) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.state.retry.maximumMs, Math.max(delay + 1, delay * 2));
      this.schedule(delay);
    }
  }

  private stopPolling() {
    this.pollerLost = true;
    if (this.timer !== undefined) this.state.context.clearTimer(this.timer);
    this.timer = undefined;
    void this.waiter?.stop();
  }

  private async reconcile() {
    if (!this.waiter) return;
    const messages = await this.waiter.wait(undefined, 0);
    if (this.stopped || this.pollerLost) return;
    await this.queueDelivery(async () => {
      this.addToNotice(messages.map((message) => message.id), false);
      this.remindNow(messages);
      await this.flushNotice();
    });
    this.nextReconcileAt = Date.now() + this.state.reconcileIntervalMs;
  }

  private queueDelivery(operation: () => void | Promise<void>) {
    const delivery = this.deliveryTail.then(operation);
    this.deliveryTail = delivery.catch(() => undefined);
    return delivery;
  }

  private addToNotice(ids: string[], advanceCursor: boolean) {
    if (this.stopped) return;
    for (const id of ids) {
      if (!this.wakeRecords.has(id) && !retainPendingId(this.pendingFresh, id, this.pendingReminders.size)) break;
      if (advanceCursor) this.pendingCursor = id;
    }
  }

  private remindNow(messages: MailMessage[]) {
    if (this.stopped) return;
    const now = Date.now();
    for (const message of messages) {
      const record = this.wakeRecords.get(message.id);
      if (!record || now - record.wokenAt < this.state.reconcileIntervalMs) continue;
      if (record.remindedAt !== undefined && now - record.remindedAt < this.state.reconcileIntervalMs) continue;
      if (!retainPendingId(this.pendingReminders, message.id, this.pendingFresh.size)) break;
    }
  }

  private scheduleNotice(delay: number) {
    if (this.stopped || this.noticeTimer !== undefined) return;
    this.noticeTimer = this.state.context.setTimeout(() => {
      this.noticeTimer = undefined;
      return this.queueDelivery(() => this.flushNotice()).catch(() => this.scheduleNotice(this.backoffMs));
    }, delay);
  }

  private async flushNotice() {
    if (this.stopped) return;
    const count = this.pendingFresh.size + this.pendingReminders.size;
    if (count > 0) {
      const remaining = this.lastNoticeAt + NOTICE_INTERVAL_MS - Date.now();
      if (remaining > 0) {
        this.scheduleNotice(remaining);
        return;
      }
      if (this.noticeTimer !== undefined) this.state.context.clearTimer(this.noticeTimer);
      this.noticeTimer = undefined;
      this.lastNoticeAt = Date.now();
      const fresh = [...this.pendingFresh];
      const reminders = [...this.pendingReminders];
      const admitted = await this.sendWake({
        customType: CUSTOM_MESSAGE_TYPE,
        content: reminders.length > 0
          ? `Quarterdeck: ${count} mail still unhandled after 10 minutes. Read it as data with qd_wait, then acknowledge it with qd_ack.`
          : `Quarterdeck: ${count} new mail. Read it as data with qd_wait, then acknowledge it with qd_ack.`,
        display: true,
      });
      if (!admitted) {
        this.scheduleNotice(Math.max(this.backoffMs, this.lastNoticeAt + NOTICE_INTERVAL_MS - Date.now()));
        throw new Error("Quarterdeck notice was refused before admission");
      }
      const now = Date.now();
      for (const id of fresh) {
        this.remember(id, now);
        this.pendingFresh.delete(id);
      }
      for (const id of reminders) {
        const record = this.wakeRecords.get(id);
        if (record) record.remindedAt = now;
        this.pendingReminders.delete(id);
      }
    }
    if (this.pendingFresh.size + this.pendingReminders.size > 0) {
      this.scheduleNotice(Math.max(0, this.lastNoticeAt + NOTICE_INTERVAL_MS - Date.now()));
      return;
    }
    if (this.pendingCursor !== undefined) {
      await this.state.cursorStore.write(this.pendingCursor);
      this.cursor = this.pendingCursor;
      this.pendingCursor = undefined;
    }
  }

  private async sendWake(message: WakeMessage) {
    try {
      if (typeof this.state.pi.sendMessageWithReceipt === "function") {
        const receipt = await this.state.pi.sendMessageWithReceipt(message, { deliverAs: "aside", triggerTurn: true });
        return receipt.admitted;
      }
      this.state.pi.sendMessage(message, { deliverAs: "aside", triggerTurn: true });
    } catch {
      return true;
    }
    return true;
  }

  private remember(id: string, wokenAt: number) {
    if (this.wakeRecords.has(id)) return;
    this.seenOrder.push(id);
    this.wakeRecords.set(id, { wokenAt });
    if (this.seenOrder.length <= SEEN_MESSAGE_IDS) return;
    const oldest = this.seenOrder.shift();
    if (oldest !== undefined) this.wakeRecords.delete(oldest);
  }

}

class QdCliWaiter {
  private stopCurrent: (() => Promise<void>) | undefined;

  constructor(private readonly config: QuarterdeckConfig) {}

  async wait(cursor: string | undefined, timeoutSeconds = this.config.waitTimeoutSeconds) {
    if (this.stopCurrent) throw new Error("Quarterdeck wait overlap");
    const command = [
      this.config.qdExecutable,
      "--config",
      this.config.botConfigPath,
      "wait",
    ];
    if (cursor !== undefined) command.push("--after", cursor);
    command.push("--timeout", String(timeoutSeconds));

    const child = Bun.spawn(command, {
      env: safeChildEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stop = async () => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      await child.exited.catch(() => undefined);
    };
    this.stopCurrent = stop;
    try {
      const output = readMessages(child.stdout);
      const exitCode = await child.exited;
      const messages = await output;
      if (exitCode !== 0) throw new Error("Quarterdeck wait failed");
      return messages;
    } catch (error) {
      await stop();
      throw error;
    } finally {
      if (this.stopCurrent === stop) this.stopCurrent = undefined;
    }
  }

  async stop() {
    await this.stopCurrent?.();
  }
}

class CursorStore {
  constructor(private readonly path: string) {}

  async read() {
    try {
      const info = await lstat(this.path);
      assertPrivateRegularFile(info, "cursor");
      const value = (await readFile(this.path, "utf8")).trim();
      if (!validCursor(value)) throw new Error("Quarterdeck cursor is invalid");
      return value;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async write(cursor: string) {
    if (!validCursor(cursor)) throw new Error("Quarterdeck cursor is invalid");
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${cursor}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch((error) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }
}

class PollerLease {
  private readonly lossHandlers = new Set<() => void>();
  private lost = false;
  private released = false;

  private constructor(
    private readonly stopHolder: () => void,
    private readonly holderExited: Promise<number>,
  ) {
    void holderExited.then(
      () => this.markLost(),
      () => this.markLost(),
    );
  }

  static async acquire(input: { flockExecutable: string; holderPath: string; lockPath: string }) {
    try {
      const lock = await open(
        input.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = await lock.stat();
        assertPrivateRegularFile(info, "poller lock");
        await lock.chmod(0o600);
      } finally {
        await lock.close().catch(() => undefined);
      }

      const holder = Bun.spawn([
        input.flockExecutable,
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "75",
        "--no-fork",
        input.lockPath,
        process.execPath,
        input.holderPath,
      ], {
        env: { ...safeChildEnvironment(), BUN_BE_BUN: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      const reader = holder.stdout.getReader();
      const first = await Promise.race([
        reader.read().then((result) => ({ kind: "read" as const, result })),
        holder.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      ]);
      reader.releaseLock();
      if (first.kind === "exit") return undefined;
      const text = new TextDecoder().decode(first.result.value);
      if (first.result.done || text !== "locked\n") {
        holder.kill("SIGTERM");
        return undefined;
      }
      return new PollerLease(() => holder.kill("SIGTERM"), holder.exited);
    } catch {
      return undefined;
    }
  }

  onLoss(handler: () => void) {
    if (this.lost) {
      handler();
      return;
    }
    this.lossHandlers.add(handler);
  }

  async release() {
    if (this.released) return;
    this.released = true;
    this.lossHandlers.clear();
    this.stopHolder();
    await this.holderExited.catch(() => undefined);
  }

  private markLost() {
    if (this.released || this.lost) return;
    this.lost = true;
    for (const handler of this.lossHandlers) handler();
    this.lossHandlers.clear();
  }
}

async function readMessages(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const messages: MailMessage[] = [];
  let buffered = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) throw new Error("Quarterdeck wait output is too large");
      buffered += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES && !buffered.includes("\n")) {
        throw new Error("Quarterdeck wait line is too large");
      }
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) messages.push(parseMessageJson(line));
        if (messages.length > MAX_BATCH_MESSAGES) throw new Error("Quarterdeck wait batch is too large");
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) messages.push(parseMessageJson(buffered));
    if (messages.length > MAX_BATCH_MESSAGES) throw new Error("Quarterdeck wait batch is too large");
    return messages;
  } finally {
    reader.releaseLock();
  }
}

function parseMessageJson(line: string) {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Quarterdeck wait returned invalid JSON");
  }
  return parseMessage(value);
}

function parseMessage(value: unknown): MailMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Quarterdeck mail is invalid");
  }
  if (!("id" in value) || !("sender" in value) || !("subject" in value)) {
    throw new Error("Quarterdeck mail is invalid");
  }
  if (typeof value.id !== "string" || typeof value.sender !== "string" || typeof value.subject !== "string") {
    throw new Error("Quarterdeck mail is invalid");
  }
  if (!validCursor(value.id)) throw new Error("Quarterdeck message id is invalid");
  return { id: value.id, sender: value.sender, subject: value.subject };
}

function parseNotification(value: unknown): McpNotification | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("server" in value) || !("method" in value) || !("params" in value)) return undefined;
  if (typeof value.server !== "string" || typeof value.method !== "string") return undefined;
  return { server: value.server, method: value.method, params: value.params };
}

function parseNotificationMessages(params: unknown) {
  if (typeof params !== "object" || params === null || Array.isArray(params) || !("messages" in params)) return [];
  if (!Array.isArray(params.messages) || params.messages.length > MAX_BATCH_MESSAGES) return [];
  try {
    return params.messages.map((message) => parseMessage(message).id);
  } catch {
    return [];
  }
}


function retainPendingId(pending: Set<string>, id: string, otherPending = 0) {
  if (pending.has(id)) return true;
  if (pending.size + otherPending >= MAX_PENDING_IDS) return false;
  pending.add(id);
  return true;
}

function configFromEnvironment(): QuarterdeckConfig {
  return {
    botConfigPath: requiredEnvironment("QUARTERDECK_CONFIG"),
    cursorRoot: process.env.QUARTERDECK_CURSOR_ROOT ?? join(homedir(), ".config", "quarterdeck"),
    mcpServer: process.env.QUARTERDECK_MCP_SERVER ?? "quarterdeck",
    qdExecutable: process.env.QUARTERDECK_QD ?? "qd.py",
    waitTimeoutSeconds: 300,
  };
}

async function readConfiguredBot(path: string) {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Quarterdeck client configuration is invalid");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document) || !("adapter" in document)) {
    throw new Error("Quarterdeck client configuration has no bot identity");
  }
  const adapter = document.adapter;
  if (typeof adapter !== "object" || adapter === null || Array.isArray(adapter) || !("bot" in adapter)) {
    throw new Error("Quarterdeck client configuration has no bot identity");
  }
  const bot = adapter.bot;
  if (typeof bot !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(bot)) {
    throw new Error("Quarterdeck client configuration has an invalid bot identity");
  }
  return bot;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeRetry(retry: RetryPolicy): RetryPolicy {
  if (!Number.isSafeInteger(retry.initialMs) || retry.initialMs < 1) throw new Error("retry initialMs is invalid");
  if (!Number.isSafeInteger(retry.maximumMs) || retry.maximumMs < retry.initialMs) {
    throw new Error("retry maximumMs is invalid");
  }
  if (retry.successMs !== undefined && (!Number.isSafeInteger(retry.successMs) || retry.successMs < 0)) {
    throw new Error("retry successMs is invalid");
  }
  return { ...retry };
}

function normalizeReconcileInterval(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("reconcile interval is invalid");
  return value;
}

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Quarterdeck bot directory is invalid");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Quarterdeck bot directory has the wrong owner");
  }
  await chmod(path, 0o700);
}

function assertPrivateRegularFile(info: { isFile(): boolean; mode: number; nlink: number; uid: number }, label: string) {
  if (!info.isFile() || info.nlink !== 1) throw new Error(`Quarterdeck ${label} is invalid`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Quarterdeck ${label} has the wrong owner`);
  }
  if ((info.mode & 0o777) !== 0o600) throw new Error(`Quarterdeck ${label} must be mode 0600`);
}

function validCursor(value: string) {
  return value.length > 0 && value.length <= 4_096 && !/[\r\n\u0000]/.test(value);
}

function safeChildEnvironment() {
  const environment: Record<string, string> = {
    HOME: process.env.HOME ?? homedir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  if (process.env.XDG_CONFIG_HOME) environment.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  return environment;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export default createQuarterdeckExtension();
