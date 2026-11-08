import { use, useEffect, useState, useSyncExternalStore } from "react";
import { useQd } from "./hooks";
import type { BotsAdmin, BotsApi, JoinedBot } from "./source";

export type { BotNote, BotsAdmin, BotsApi, CleanupDays, HistoryLine, JoinedBot, OpenInvite, PendingJoin } from "./source";

type Load = () => Promise<BotsApi>;

const loads = new WeakMap<Load, Promise<BotsApi>>();

function loadBots(load: Load): Promise<BotsApi> {
  let loading = loads.get(load);
  if (!loading) {
    loading = load();
    loads.set(load, loading);
    loading.catch(() => loads.delete(load));
  }
  return loading;
}

const quiet = () => () => undefined;

const NONE: JoinedBot[] = [];

export function useBotsApi(): BotsApi | null {
  const { bots } = useQd();
  return bots ? use(loadBots(bots)) : null;
}

export function useBotsAdmin(): BotsAdmin | null {
  const api = useBotsApi();
  return useSyncExternalStore(api ? api.subscribe : quiet, () => (api ? api.current() : null));
}

export function useJoinedBots(): JoinedBot[] {
  const { bots } = useQd();
  const [api, setApi] = useState<BotsApi | null>(null);
  useEffect(() => {
    if (!bots || __QD_SOURCE__ === "server") return;
    let live = true;
    loadBots(bots).then(
      (loaded) => live && setApi(loaded),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bots]);
  return useSyncExternalStore(api ? api.subscribe : quiet, () => (api ? api.current().joined : NONE));
}
