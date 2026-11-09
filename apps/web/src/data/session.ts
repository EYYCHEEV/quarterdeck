import { useCallback, useSyncExternalStore } from "react";
import type { InspectedFile, PrepareFiles } from "../domain/file-inspection";
import { EMPTY_MAIL_QUERY, type MailQuery } from "../domain/mail-query";
import type { PageQuery } from "../domain/pages";
import { EMPTY_QUERY, type QueueQuery } from "../domain/query";
import type { Attachment, Quote } from "./chat-types";

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

export function readSession<T>(key: string, initial: T): T {
  return values.has(key) ? (values.get(key) as T) : initial;
}

export function writeSession<T>(key: string, value: T) {
  values.set(key, value);
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

export function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set);
  set.add(listener);
  return () => set.delete(listener);
}

export function useSession<T>(key: string, initial: T): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => readSession(key, initial),
  );
  const set = useCallback((next: T) => writeSession(key, next), [key]);
  return [value, set];
}

export type Receipt = { text: string; cardId: string | null };

export const useQueueQuery = () => useSession<QueueQuery>("queue.query", EMPTY_QUERY);

export const usePagesQuery = (projectId: string, empty: PageQuery) => useSession<PageQuery>("pages.query." + projectId, empty);

export const useReceipt = () => useSession<Receipt | null>("receipt", null);

export type DraftFile = { id: string; file: InspectedFile; url: string };

export type ChatDraft = { text: string; quote: Quote | null; files: DraftFile[] };

const EMPTY_DRAFT: ChatDraft = { text: "", quote: null, files: [] };

export const useChatDraft = (botId: string) => useSession<ChatDraft>("chat.draft." + botId, EMPTY_DRAFT);

const attachmentBatches = new Map<string, Promise<string[]>>();
let generation = 0;

export function attachChatFiles(botId: string, files: File[], prepare: PrepareFiles): Promise<string[]> {
  const key = "chat.draft." + botId;
  const at = generation;
  const add = async () => {
    const before = readSession(key, EMPTY_DRAFT);
    const { accepted, refused } = await prepare(files, before.files.length);
    if (accepted.length && at === generation) {
      const current = readSession(key, EMPTY_DRAFT);
      const additions = accepted.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
      writeSession(key, { ...current, files: [...current.files, ...additions] });
    }
    return refused;
  };
  const previous = attachmentBatches.get(botId);
  const current = previous ? previous.then(add, add) : add();
  const queued = current.finally(() => {
    if (attachmentBatches.get(botId) === queued) attachmentBatches.delete(botId);
  });
  attachmentBatches.set(botId, queued);
  return queued;
}

export type PendingSend = { clientId: string; text: string; quote: Quote | null; files: InspectedFile[]; previews: Attachment[]; failed: boolean; at: string; after: string | null; reason?: string | null; retry?: boolean };

const NO_PENDING: PendingSend[] = [];

export const usePendingSends = (botId: string) => useSession<PendingSend[]>("chat.pending." + botId, NO_PENDING)[0];

export function updatePendingSends(botId: string, change: (list: PendingSend[]) => PendingSend[]) {
  const key = "chat.pending." + botId;
  writeSession(key, change(readSession(key, NO_PENDING)));
}

export function quoteInChat(botId: string, quote: Quote) {
  const key = "chat.draft." + botId;
  writeSession<ChatDraft>(key, { ...readSession(key, EMPTY_DRAFT), quote });
}

export const useMailQuery = () => useSession<MailQuery>("mail.query", EMPTY_MAIL_QUERY);

export function clearSession(): Map<string, unknown> {
  generation += 1;
  const old = new Map(values);
  values.clear();
  for (const set of listeners.values()) for (const listener of [...set]) listener();
  return old;
}

export const sessionGeneration = (): number => generation;
