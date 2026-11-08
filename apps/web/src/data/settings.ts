import { useSyncExternalStore } from "react";
import { readJson, removeJson, writeJson } from "../platform/storage";

export type Appearance = "system" | "light" | "dark";

const APPEARANCES: Appearance[] = ["system", "light", "dark"];

export type Settings = { appearance: Appearance; email: string };

const KEY = "qd.settings";
const DEFAULTS: Settings = { appearance: "system", email: "captain@example.com" };
const listeners = new Set<() => void>();

function load(): Settings {
  const saved = readJson(KEY) as Partial<Settings> | null;
  return { ...DEFAULTS, appearance: APPEARANCES.find((appearance) => appearance === saved?.appearance) ?? DEFAULTS.appearance };
}

let current = load();

function readSettings(): Settings {
  return current;
}

export function saveSettings(next: Settings) {
  current = next;
  writeJson(KEY, { appearance: next.appearance });
  for (const listener of [...listeners]) listener();
}

export function clearSettings() {
  current = DEFAULTS;
  removeJson(KEY);
  for (const listener of [...listeners]) listener();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readSettings,
  );
}
