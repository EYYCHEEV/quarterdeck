import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

export const DRAFTS_KEY = "quarterdeck.drafts.v1";
const SAVE_AFTER_MS = 300;

export interface DraftStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

interface DraftState {
  readonly drafts: ReadonlyMap<string, string>;
  readonly saved: boolean;
}

export interface DraftStore {
  readonly state: StoreApi<DraftState>;
  readonly setDraft: (chatId: string, text: string) => void;
  readonly flush: () => void;
  readonly clearAll: () => void;
}

export const deviceStorage: DraftStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};

const readStored = (storage: DraftStorage): Map<string, string> => {
  const drafts = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return drafts;
    for (const [chatId, text] of Object.entries(parsed)) {
      if (typeof text === "string" && text !== "") drafts.set(chatId, text);
    }
  } catch {
    drafts.clear();
  }
  return drafts;
};

const writeOne = (storage: DraftStorage, chatId: string, text: string): boolean => {
  const stored = readStored(storage);
  if (text === "") stored.delete(chatId);
  else stored.set(chatId, text);
  try {
    if (stored.size === 0) storage.removeItem(DRAFTS_KEY);
    else storage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(stored)));
    return true;
  } catch {
    return false;
  }
};

export const createDraftStore = (storage: DraftStorage): DraftStore => {
  const state = createStore<DraftState>(() => ({ drafts: readStored(storage), saved: true }));
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (waiting.size === 0) return;
    let saved = true;
    for (const chatId of waiting) {
      saved = writeOne(storage, chatId, state.getState().drafts.get(chatId) ?? "") && saved;
    }
    waiting.clear();
    if (state.getState().saved !== saved) state.setState({ saved });
  };
  const setDraft = (chatId: string, text: string): void => {
    const drafts = new Map(state.getState().drafts);
    if (text === "") drafts.delete(chatId);
    else drafts.set(chatId, text);
    state.setState({ drafts });
    waiting.add(chatId);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_AFTER_MS);
  };
  const clearAll = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    waiting.clear();
    let saved = true;
    try {
      storage.removeItem(DRAFTS_KEY);
    } catch {
      saved = false;
    }
    state.setState({ drafts: new Map(), saved });
  };
  return { state, setDraft, flush, clearAll };
};

export const saveOnLeave = (store: DraftStore): (() => void) => {
  const onLeave = (): void => store.flush();
  const onHide = (): void => {
    if (document.visibilityState === "hidden") store.flush();
  };
  window.addEventListener("pagehide", onLeave);
  document.addEventListener("visibilitychange", onHide);
  return () => {
    window.removeEventListener("pagehide", onLeave);
    document.removeEventListener("visibilitychange", onHide);
  };
};

export const useDraft = (store: DraftStore, chatId: string): string =>
  useStore(store.state, (state) => state.drafts.get(chatId) ?? "");
