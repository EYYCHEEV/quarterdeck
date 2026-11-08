import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Tracker } from "../domain/tracker";
import type { CardEvidence, World } from "../domain/types";
import { createLoader, type Loader } from "./loader";
import type { QdData } from "./source";

type Loaded = { world: World; at: number };

type Feed = { data: QdData; loader: Loader<Loaded>; trackers: Loader<Record<string, Tracker>> };

const Ctx = createContext<Feed | null>(null);

export function createFeed(data: QdData): Feed {
  return {
    data,
    loader: createLoader(
      async () => ({ world: await data.load(), at: data.loadedAt ? data.loadedAt() : data.now() }),
      (onChange) => data.watch(onChange),
    ),
    trackers: createLoader(
      () => data.trackers(),
      (onChange) => data.watch(onChange),
    ),
  };
}

export function DataProvider({ data, children }: { data: QdData; children: ReactNode }) {
  const feed = useMemo(() => createFeed(data), [data]);
  return <Ctx.Provider value={feed}>{children}</Ctx.Provider>;
}

function useFeed(): Feed {
  const feed = useContext(Ctx);
  if (!feed) throw new Error("Quarterdeck data source missing");
  return feed;
}

export function useQd(): QdData {
  return useFeed().data;
}

export type WorldState = { world: World | null; at: number | null; failed: boolean; retry: () => void };

export function useWorld(): WorldState {
  const { loader } = useFeed();
  const loaded = useSyncExternalStore(loader.subscribe, loader.snapshot);
  return { world: loaded.value?.world ?? null, at: loaded.value?.at ?? null, failed: loaded.failed, retry: loader.refresh };
}

export function useSignIn() {
  const { data, loader } = useFeed();
  const loaded = useSyncExternalStore(loader.subscribe, loader.snapshot);
  return { required: loaded.signIn, unconfirmed: loaded.unconfirmed, quiet: loaded.quiet, refresh: loader.refresh, retry: () => { data.signIn?.(); loader.refresh(); } };
}

export type EvidenceState = { evidence: CardEvidence | null; loaded: boolean; failed: boolean; retry: () => void };

export function useEvidence(cardId: string): EvidenceState {
  const qd = useQd();
  const [got, setGot] = useState<{ cardId: string; evidence: CardEvidence | null; failed: boolean } | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    qd.evidence(cardId).then(
      (evidence) => live && setGot({ cardId, evidence, failed: false }),
      () => live && setGot({ cardId, evidence: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [qd, cardId, tries]);
  const current = got?.cardId === cardId ? got : null;
  return { evidence: current?.evidence ?? null, loaded: current !== null, failed: current?.failed ?? false, retry: () => setTries((n) => n + 1) };
}

export type TrackerState = { trackers: Record<string, Tracker> | null; failed: boolean; retry: () => void };

export function useTrackers(): TrackerState {
  const { trackers } = useFeed();
  const loaded = useSyncExternalStore(trackers.subscribe, trackers.snapshot);
  return { trackers: loaded.value, failed: loaded.failed, retry: trackers.refresh };
}
