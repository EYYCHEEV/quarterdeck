import { LapsedWhileHidden, SessionUnconfirmed, SignInRequired } from "./source";

export type Loaded<T> = { value: T | null; failed: boolean; signIn?: true; unconfirmed?: true; quiet?: true };

export type Loader<T> = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => Loaded<T>;
  refresh: () => void;
};

function failedState<T>(current: Loaded<T>, error: unknown): Loaded<T> {
  if (error instanceof SignInRequired) return { value: null, failed: true, signIn: true };
  if (error instanceof LapsedWhileHidden) return { value: null, failed: false, unconfirmed: true, quiet: true };
  if (error instanceof SessionUnconfirmed) return { value: null, failed: true, unconfirmed: true };
  return { ...current, failed: true };
}

export function createLoader<T>(load: () => Promise<T>, watch: (onChange: (failure?: Error) => void) => () => void): Loader<T> {
  let current: Loaded<T> = { value: null, failed: false };
  let round = 0;
  let stopWatching: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: Loaded<T>) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };

  const refresh = () => {
    const mine = ++round;
    load().then(
      (value) => {
        if (mine === round && stopWatching) publish({ value, failed: false });
      },
      typeof __QD_SOURCE__ === "undefined" || __QD_SOURCE__ === "server" ? (error) => {
        if (mine === round && stopWatching) publish(failedState(current, error));
      } : () => {
        if (mine === round && stopWatching) publish({ value: current.value, failed: true });
      },
    );
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!stopWatching) {
      stopWatching = watch(typeof __QD_SOURCE__ === "undefined" || __QD_SOURCE__ === "server" ? (failure) => {
        if (failure) {
          round += 1;
          if (listeners.size > 0) publish(failedState(current, failure));
        } else refresh();
      } : refresh);
      refresh();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && stopWatching) {
        stopWatching();
        stopWatching = null;
      }
    };
  };

  return { subscribe, snapshot: () => current, refresh };
}
