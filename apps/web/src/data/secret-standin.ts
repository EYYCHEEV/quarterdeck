import { checkSecretBotLabel, checkSecretName, checkSecretReason, checkSecretValue, SECRET_TEXT, secretText, type SecretEvent, type SecretRequest, type SecretRow } from "../domain/secrets";
import type { BotSecretsApi, CaptainSecretsApi, SaveTarget } from "./secret-types";
import { Refused } from "./source";

export type SecretBot = { id: string; name: string };

export type SecretSeed = { rows: SecretRow[]; requests: SecretRequest[]; events: SecretEvent[]; gone: string[] };

export type SecretSnapshot = { rows: SecretRow[]; requests: SecretRequest[]; events: SecretEvent[] };

export type CaptainFixtureSession = { accountId: string; activeChat: { id: string; botId: string } | null };

export type SecretConsumer = (row: Readonly<SecretRow>) => Promise<"accepted" | "refused">;

export type SecretStandIn = {
  captain: CaptainSecretsApi;
  botFor: (session: { accountId: string; botId: string }) => BotSecretsApi;
  removeBot: (botId: string) => void;
  snapshot: () => SecretSnapshot;
};

export type SecretOptions = {
  now: () => number;
  bots: () => readonly SecretBot[];
  accountId: string;
  session: () => CaptainFixtureSession;
  consumers: Readonly<Record<string, SecretConsumer>>;
  latency?: () => number;
  failWrite?: () => boolean;
  seed?: SecretSeed;
};

const copy = <T extends object>(item: T): T => ({ ...item });

export function createSecretStandIn(options: SecretOptions): SecretStandIn {
  const rows = new Map<string, SecretRow>((options.seed?.rows ?? []).map((row) => [row.id, copy(row)]));
  const requests = new Map<string, SecretRequest>((options.seed?.requests ?? []).map((item) => [item.id, copy(item)]));
  const events: SecretEvent[] = (options.seed?.events ?? []).map(copy);
  const gone = new Set<string>(options.seed?.gone ?? []);
  const keys = new Map<string, { binding: string; result: SecretRow }>();
  const requestRows = new Map<string, string>();
  const consumers = { ...options.consumers };
  const accountId = options.accountId;
  const listeners = new Set<() => void>();
  const latency = options.latency ?? (() => 0);
  const failWrite = options.failWrite ?? (() => false);
  let counter = 0;

  const nextId = (prefix: string) => {
    do counter += 1;
    while (rows.has(prefix + "-" + counter) || requests.has(prefix + "-" + counter) || events.some((event) => event.id === prefix + "-" + counter));
    return prefix + "-" + counter;
  };
  const stamp = () => new Date(options.now()).toISOString();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const pause = () => {
    const ms = latency();
    return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  };
  const nameOf = (botId: string) => options.bots().find((bot) => bot.id === botId)?.name ?? botId;
  const live = (botId: string) => !gone.has(botId) && options.bots().some((bot) => bot.id === botId);
  const record = (botId: string, kind: SecretEvent["kind"], name: string) => {
    events.push({ id: nextId("sev"), botId, kind, name, at: stamp() });
  };
  const captainSession = () => {
    const session = options.session();
    if (session.accountId !== accountId) throw new Refused("Secret operation not allowed.");
    return { accountId, activeChat: session.activeChat ? copy(session.activeChat) : null };
  };
  const approved = (consumerId: string) => {
    if (!Object.hasOwn(consumers, consumerId)) throw new Refused("Secret consumer not allowed.");
    return consumers[consumerId];
  };
  const fields = (input: object, allowed: readonly string[]) => {
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Refused("Secret operation not allowed.");
  };
  const replay = (key: string, binding: string): SecretRow | null => {
    if (typeof key !== "string" || !key.trim()) throw new Refused("A secret operation needs a retry key.");
    const earlier = keys.get(key);
    if (!earlier) return null;
    if (earlier.binding !== binding) throw new Refused("That retry key belongs to another secret operation.");
    if (!rows.has(earlier.result.id)) throw new Refused("That secret operation already happened and the secret was deleted.");
    return copy(earlier.result);
  };

  const ask = (botId: string, input: Parameters<BotSecretsApi["ask"]>[0]): SecretRequest => {
    fields(input, ["name", "reason", "consumerId"]);
    if (!live(botId)) throw new Refused("no such bot");
    const botLabel = checkSecretBotLabel(nameOf(botId));
    if (!botLabel.ok) throw new Refused(botLabel.reason);
    approved(input.consumerId);
    const name = checkSecretName(input.name);
    if (!name.ok) throw new Refused(name.reason);
    const reason = checkSecretReason(input.reason);
    if (!reason.ok) throw new Refused(reason.reason);
    const open = [...requests.values()].find((item) => item.botId === botId && item.name === name.name && item.consumerId === input.consumerId && item.status === "asking");
    if (open) return copy(open);
    const request: SecretRequest = { id: nextId("req"), botId, name: name.name, reason: reason.text, consumerId: input.consumerId, at: stamp(), status: "asking" };
    requests.set(request.id, request);
    notify();
    return copy(request);
  };

  const writeRow = (botId: string, name: string, update: boolean): SecretRow => {
    const same = [...rows.values()].find((row) => row.botId === botId && row.name === name);
    if (same && !update) throw new Refused(secretText.taken(name, nameOf(botId)));
    const row: SecretRow = same ?? { id: nextId("sec"), botId, name, savedAt: stamp(), lastUsedAt: null, locked: false };
    row.savedAt = stamp();
    row.lastUsedAt = null;
    rows.set(row.id, row);
    record(botId, "saved", name);
    return row;
  };

  const commitSave = (target: SaveTarget, session: CaptainFixtureSession): SecretRow => {
    if (target.kind === "request") {
      const request = requests.get(target.requestId);
      if (!request) throw new Refused("no such request");
      if (!live(request.botId)) throw new Refused(secretText.ended(nameOf(request.botId)));
      approved(request.consumerId);
      const binding = JSON.stringify([accountId, "save-request", request.botId, request.id, request.name, request.consumerId]);
      const earlier = replay(target.key, binding);
      if (earlier) return earlier;
      if (request.status === "saved") {
        const done = rows.get(requestRows.get(request.id) ?? "");
        if (!done) throw new Refused("That secret operation already happened and the secret was deleted.");
        keys.set(target.key, { binding, result: copy(done) });
        return copy(done);
      }
      if (request.status !== "asking") throw new Refused(secretText.ended(nameOf(request.botId)));
      const row = writeRow(request.botId, request.name, true);
      request.status = "saved";
      requestRows.set(request.id, row.id);
      keys.set(target.key, { binding, result: copy(row) });
      notify();
      return copy(row);
    }
    const botId = session.activeChat?.botId;
    if (!botId || !live(botId)) throw new Refused("Open the bot's active chat first.");
    const name = checkSecretName(target.name);
    if (!name.ok) throw new Refused(name.reason);
    const binding = JSON.stringify([accountId, "save-direct", botId, session.activeChat?.id, name.name]);
    const earlier = replay(target.key, binding);
    if (earlier) return earlier;
    const row = writeRow(botId, name.name, false);
    keys.set(target.key, { binding, result: copy(row) });
    notify();
    return copy(row);
  };

  const commitReplace = (secretId: string, key: string): SecretRow => {
    const row = rows.get(secretId);
    if (!row) throw new Refused("no such secret");
    if (row.locked || !live(row.botId)) throw new Refused(secretText.lockedWhy(nameOf(row.botId)));
    const binding = JSON.stringify([accountId, "replace", row.botId, row.id, row.name]);
    const earlier = replay(key, binding);
    if (earlier) return earlier;
    row.savedAt = stamp();
    row.lastUsedAt = null;
    record(row.botId, "saved", row.name);
    keys.set(key, { binding, result: copy(row) });
    notify();
    return copy(row);
  };

  const save: CaptainSecretsApi["save"] = async (input, value) => {
    const session = captainSession();
    if (input.kind !== "direct" && input.kind !== "request") throw new Refused("Secret operation not allowed.");
    fields(input, input.kind === "direct" ? ["kind", "name", "key"] : ["kind", "requestId", "key"]);
    const target = copy(input);
    const check = checkSecretValue(value);
    if (!check.ok) throw new Refused(check.reason);
    await pause();
    const current = captainSession();
    if (target.kind === "direct" && (current.activeChat?.id !== session.activeChat?.id || current.activeChat?.botId !== session.activeChat?.botId)) throw new Refused("The active chat changed. Open a new secret box.");
    if (failWrite()) throw new Error(SECRET_TEXT.saveFailed);
    return commitSave(target, session);
  };

  const replace: CaptainSecretsApi["replace"] = async (secretId, value, key) => {
    captainSession();
    const check = checkSecretValue(value);
    if (!check.ok) throw new Refused(check.reason);
    await pause();
    captainSession();
    if (failWrite()) throw new Error(SECRET_TEXT.replaceFailed);
    return commitReplace(secretId, key);
  };

  const decline = (requestId: string) => {
    captainSession();
    const request = requests.get(requestId);
    if (!request) throw new Refused("no such request");
    if (request.status === "declined") return;
    if (request.status !== "asking") throw new Refused(secretText.ended(nameOf(request.botId)));
    request.status = "declined";
    record(request.botId, "declined", request.name);
    notify();
  };

  const remove = async (secretId: string): Promise<void> => {
    captainSession();
    await pause();
    captainSession();
    if (rows.delete(secretId)) notify();
  };

  const use = async (botId: string, input: Parameters<BotSecretsApi["use"]>[0]): Promise<void> => {
    fields(input, ["secretId", "consumerId"]);
    const { secretId, consumerId } = input;
    await pause();
    const row = rows.get(secretId);
    const mine = row !== undefined && row.botId === botId;
    const failure = secretText.useFailed(nameOf(botId), mine ? row.name : "that secret");
    if (!row || !mine || row.locked || !live(botId)) throw new Refused(failure);
    const consumer = approved(consumerId);
    const savedAt = row.savedAt;
    let result: "accepted" | "refused";
    try {
      result = await consumer(copy(row));
    } catch {
      throw new Refused(failure);
    }
    if (result !== "accepted" || rows.get(secretId) !== row || row.locked || !live(botId) || row.savedAt !== savedAt) throw new Refused(failure);
    row.lastUsedAt = stamp();
    notify();
  };

  const removeBot = (botId: string) => {
    gone.add(botId);
    for (const row of rows.values()) if (row.botId === botId) row.locked = true;
    for (const request of requests.values()) {
      if (request.botId !== botId || request.status !== "asking") continue;
      request.status = "ended";
      record(botId, "ended", request.name);
    }
    notify();
  };

  const newest = (a: SecretRow, b: SecretRow) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || a.name.localeCompare(b.name);

  return {
    captain: {
      rows: (botId) => { captainSession(); return [...rows.values()].filter((row) => row.botId === botId).sort(newest).map(copy); },
      requests: (botId) => { captainSession(); return [...requests.values()].filter((item) => item.botId === botId).map(copy); },
      events: (botId) => { captainSession(); return events.filter((item) => item.botId === botId).map(copy); },
      subscribe: (onChange) => {
        captainSession();
        listeners.add(onChange);
        return () => { listeners.delete(onChange); };
      },
      save,
      decline,
      replace,
      remove,
    },
    botFor: (session) => {
      const { accountId: botAccountId, botId } = session;
      if (botAccountId !== accountId) throw new Refused("Secret operation not allowed.");
      return { ask: (input) => ask(botId, input), use: (input) => use(botId, input) };
    },
    removeBot,
    snapshot: () => ({ rows: [...rows.values()].map(copy), requests: [...requests.values()].map(copy), events: events.map(copy) }),
  };
}
