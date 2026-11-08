import type { BrowserChatApi } from "./chat-types";
import type { CaptainSecretsApi, SecretsStatus } from "./secret-types";
import { Refused } from "./source";

const secretNotReady = () => Promise.reject(new Refused("Secret controls are not ready yet."));

type ColdSecretListener = { onChange: () => void; stopped: boolean; stop: (() => void) | null };

type Owed<Api> = { start: (api: Api) => () => void; stopped: boolean; stop: (() => void) | null };

function lazyPart<Api>(load: () => Promise<Api>) {
  const owed = new Set<Owed<Api>>();
  const open = async (): Promise<Api> => {
    const api = await load();
    for (const starter of [...owed]) {
      owed.delete(starter);
      if (starter.stopped) continue;
      try {
        starter.stop = starter.start(api);
      } catch {
        starter.stopped = true;
      }
    }
    return api;
  };
  const whenReady = (start: (api: Api) => () => void): (() => void) => {
    const starter: Owed<Api> = { start, stopped: false, stop: null };
    owed.add(starter);
    open().catch(() => undefined);
    return () => {
      starter.stopped = true;
      owed.delete(starter);
      starter.stop?.();
      starter.stop = null;
    };
  };
  return { open, whenReady };
}

export function lazyChat(load: () => Promise<BrowserChatApi>): BrowserChatApi {
  const { open, whenReady } = lazyPart(load);
  return {
    uploadBoundary: "browser-stand-in",
    listChats: async () => (await open()).listChats(),
    openThread: async (botId) => (await open()).openThread(botId),
    send: async (botId, message) => (await open()).send(botId, message),
    watchChats: (onChange) => whenReady((chat) => chat.watchChats(onChange)),
    subscribe: (botId, onChange) => whenReady((chat) => chat.subscribe(botId, onChange)),
  };
}

export function lazySecrets(load: () => Promise<CaptainSecretsApi>): CaptainSecretsApi {
  let api: CaptainSecretsApi | null = null;
  let pending: Promise<CaptainSecretsApi> | null = null;
  let status: SecretsStatus = "loading";
  const waiting = new Set<ColdSecretListener>();
  const tell = () => {
    for (const listener of [...waiting]) if (!listener.stopped) listener.onChange();
  };
  const open = (): Promise<CaptainSecretsApi> => {
    if (!pending) {
      const retrying = status === "failed";
      status = "loading";
      let loading: Promise<CaptainSecretsApi>;
      try {
        loading = load();
      } catch (error) {
        loading = Promise.reject(error);
      }
      pending = loading.then((loaded) => {
        const ready: ColdSecretListener[] = [];
        for (const listener of waiting) {
          waiting.delete(listener);
          if (listener.stopped) continue;
          try {
            const stop = loaded.subscribe(listener.onChange);
            if (listener.stopped) stop();
            else {
              listener.stop = stop;
              ready.push(listener);
            }
          } catch {
            listener.stopped = true;
          }
        }
        api = loaded;
        status = "ready";
        queueMicrotask(() => {
          for (const listener of ready) if (!listener.stopped) listener.onChange();
        });
        return loaded;
      }).catch((error: unknown) => {
        api = null;
        pending = null;
        status = "failed";
        queueMicrotask(tell);
        throw error;
      });
      if (retrying) tell();
    }
    return pending;
  };
  const begin = () => {
    open().catch(() => undefined);
  };
  return {
    rows: (botId) => api?.rows(botId) ?? [],
    requests: (botId) => api?.requests(botId) ?? [],
    events: (botId) => api?.events(botId) ?? [],
    subscribe: (onChange) => {
      if (api) return api.subscribe(onChange);
      const listener: ColdSecretListener = { onChange, stopped: false, stop: null };
      waiting.add(listener);
      begin();
      return () => {
        if (listener.stopped) return;
        listener.stopped = true;
        waiting.delete(listener);
        listener.stop?.();
        listener.stop = null;
      };
    },
    save: (target, value) => api ? api.save(target, value) : secretNotReady(),
    decline: (requestId) => api?.decline(requestId),
    replace: (secretId, value, key) => api ? api.replace(secretId, value, key) : secretNotReady(),
    remove: (secretId) => api ? api.remove(secretId) : secretNotReady(),
    status: () => status,
    reload: () => {
      if (status === "failed") begin();
    },
  };
}
