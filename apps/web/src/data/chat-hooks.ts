import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { menuDot } from "../domain/seen";
import type { ChatMessage, ChatRow, ChatThread, Outgoing } from "./chat-types";
import { useQd, useWorld } from "./hooks";

export type Loaded<T> = { value: T | null; failed: boolean; retry: () => void };

let listed = false;
const listedHeard = new Set<() => void>();

function markListed() {
  if (listed) return;
  listed = true;
  for (const heard of [...listedHeard]) heard();
}

function hearListed(onChange: () => void) {
  listedHeard.add(onChange);
  return () => listedHeard.delete(onChange);
}

export function useChatRows(): Loaded<ChatRow[]> {
  const { chat } = useQd();
  const [value, setValue] = useState<ChatRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      chat.listChats().then(
        (rows) => {
          if (!live) return;
          setValue(rows);
          setFailed(false);
          markListed();
        },
        () => {
          if (live) setFailed(true);
        },
      );
    };
    load();
    const stop = chat.watchChats(load);
    return () => {
      live = false;
      stop();
    };
  }, [chat, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { value, failed, retry };
}

export function useNewActivity(openBotId: string | null = null): boolean {
  const { chat } = useQd();
  const { world } = useWorld();
  const ready = useSyncExternalStore(hearListed, () => listed);
  const [chats, setChats] = useState<ChatRow[] | null>(null);
  useEffect(() => {
    if (!ready || (typeof __QD_CHAT__ !== "undefined" && __QD_CHAT__ === "on")) return;
    let live = true;
    const load = () => void chat.listChats().then((rows) => live && setChats(rows), () => undefined);
    load();
    const stop = chat.watchChats(load);
    return () => {
      live = false;
      stop();
    };
  }, [chat, ready]);
  return world ? menuDot(world.lanes, world.bots, chats, openBotId) : false;
}

export type ThreadState = Loaded<ChatThread> & { send: (message: Outgoing) => Promise<void> };

export function useThread(botId: string): ThreadState {
  const { chat } = useQd();
  const [state, setState] = useState<{ botId: string; thread: ChatThread | null; failed: boolean }>({ botId, thread: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ botId, thread: null, failed: false });
    const stop = chat.subscribe(botId, (thread) => {
      if (live) setState({ botId, thread, failed: false });
    });
    chat.openThread(botId).then(
      (thread) => {
        if (live) setState({ botId, thread, failed: false });
      },
      () => {
        if (live) setState({ botId, thread: null, failed: true });
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [chat, botId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const send = useCallback(
    async (outgoing: Outgoing) => {
      const sent = queue.current.then(async () => chat.send(botId, outgoing));
      queue.current = sent.catch(() => undefined);
      const message = await sent;
      setState((before) => {
        if (before.botId !== botId || !before.thread || before.thread.messages.some((item: ChatMessage) => item.id === message.id)) return before;
        return { ...before, thread: { ...before.thread, messages: [...before.thread.messages, message] } };
      });
    },
    [chat, botId],
  );
  const here = state.botId === botId;
  return { value: here ? state.thread : null, failed: here ? state.failed : false, retry, send };
}
