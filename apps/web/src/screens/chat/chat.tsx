import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { useThread } from "../../data/chat-hooks";
import type { Attachment, ChatMessage } from "../../data/chat-types";
import { useQd, useWorld } from "../../data/hooks";
import { useSecrets } from "../../data/secret-hooks";
import { attachChatFiles, updatePendingSends, useChatDraft, usePendingSends, type PendingSend } from "../../data/session";
import { RateLimited, Refused } from "../../data/source";
import { isCardQuote, messageQuote, SEND_FAILED_TEXT, SEND_LONG_TEXT, SEND_RATE_TEXT, withCardLine, withinLimit } from "../../domain/chat";
import { admit, kindOf, pictureCaption } from "../../domain/chat-files";
import { dayKey, dayLabel } from "../../domain/time";
import { Button } from "../../ui/button";
import { useShown } from "../../ui/motion";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";
import { Viewer } from "../../ui/viewer";
import { AlertChoices, Arrival, useArrival, useSound } from "./alerts";
import { FileViewer } from "./attachments";
import { Composer } from "./composer";
import { ChatHeader } from "./header";
import { SelectionQuote } from "./message-actions";
import { BotMessage, MyMessage, NewLine, WorkingLine } from "./messages";
import { QuoteBlock } from "./quote";
import { SecretCard, SecretLine } from "./secret-box";

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

const refusal = (error: unknown): Pick<PendingSend, "reason" | "retry"> => {
  if (error instanceof RateLimited) return { reason: SEND_RATE_TEXT, retry: true };
  if (error instanceof Refused && error.message !== SEND_FAILED_TEXT) return { reason: error.message, retry: false };
  return { reason: null, retry: true };
};

let olderPlace: { botId: string; oldest: string | undefined; fromEnd: number } | null = null;
let olderMoved = false;

function OlderRow({ botId, oldest, pane }: { botId: string; oldest: string | undefined; pane: RefObject<HTMLDivElement | null> }) {
  const { chat } = useQd();
  const [held, setHeld] = useState<{ botId: string; state: "idle" | "loading" | "failed" }>({ botId, state: "idle" });
  const state = held.botId === botId ? held.state : "idle";
  const load = () => {
    if (chat.uploadBoundary !== "server" || state === "loading") return;
    olderPlace = { botId, oldest, fromEnd: pane.current ? pane.current.scrollHeight - pane.current.scrollTop : 0 };
    setHeld({ botId, state: "loading" });
    chat.older(botId).then(
      () => setHeld((now) => (now.botId === botId ? { botId, state: "idle" } : now)),
      () => {
        olderPlace = null;
        setHeld((now) => (now.botId === botId ? { botId, state: "failed" } : now));
      },
    );
  };
  return (
    <li className="chat-older flex justify-center">
      {state === "failed" ? (
        <ErrorLine onRetry={load}>Could not load older messages.</ErrorLine>
      ) : (
        <Button kind="ghost" onClick={load} disabled={state === "loading"} data-testid="chat-older">
          {state === "loading" ? "Loading older" : "Show older"}
        </Button>
      )}
    </li>
  );
}

export function ChatScreen({ botId }: { botId: string }) {
  const qd = useQd();
  const { world } = useWorld();
  const thread = useThread(botId);
  const canReply = thread.value?.features.includes("quote") ?? false;
  const [draft, setDraft] = useChatDraft(botId);
  const pending = usePendingSends(botId);
  const setPending = (change: (list: PendingSend[]) => PendingSend[]) => updatePendingSends(botId, change);
  const pane = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const depth = useRef(0);
  const activeBot = useRef(botId);
  const firstNew = useRef<{ botId: string; id: string | null } | null>(null);
  activeBot.current = botId;
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [gallery, setGallery] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [focusNext, setFocusNext] = useState<{ target: () => HTMLElement | null } | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const secrets = useSecrets(botId);
  const secretsReady = !secrets.loading && !secrets.failed;
  const [boxOpen, setBoxOpen] = useState(false);
  const bot = world?.bots.find((b) => b.id === botId) ?? (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" ? (thread.value?.bot ?? null) : null);
  const [sound, toggleSound] = useSound();
  const [arrival, dismissArrival] = useArrival(bot);
  const choices = <AlertChoices sound={sound} onSound={toggleSound} />;
  const messages = thread.value?.messages ?? [];
  if (thread.value && firstNew.current?.botId !== botId) firstNew.current = { botId, id: thread.value.firstUnread };
  const newId = firstNew.current?.botId === botId ? firstNew.current.id : null;
  const sentIds = new Set(messages.map((m) => m.clientId).filter(Boolean));
  const waiting = pending.filter((p) => !sentIds.has(p.clientId));
  const seenAt = thread.value?.seenUpTo ? messages.findIndex((m) => m.id === thread.value?.seenUpTo) : -1;
  const working = thread.value?.working ?? null;
  const arrived = useShown(messages, (message) => message.id, thread.value ? "shown" : "", true);
  const fresh = new Set(arrived.shown.filter((entry) => entry.fresh).map((entry) => entry.id));
  let latest = -1;
  for (let n = 0; n < messages.length; n++) if (messages[n].from === "captain") latest = n;
  const now = qd.now();
  const pictures = [
    ...messages.map((message) => ({ files: message.attachments ?? [], who: message.from === "bot" ? (bot?.name ?? "") : "You", at: message.at })),
    ...waiting.map((item) => ({ files: item.previews, who: "You", at: item.at })),
  ].flatMap(({ files, who, at }) =>
    files.filter((file) => kindOf(file) === "image").map((file) => ({ id: file.id, kind: "image" as const, src: file.url, poster: null, type: file.type || null, caption: pictureCaption(file, who, at, now) })),
  );
  const open = (file: Attachment, from: HTMLElement) => {
    opener.current = from;
    if (kindOf(file) === "file") return setViewing(file);
    const at = pictures.findIndex((item) => item.id === file.id);
    if (at >= 0) setGallery(at);
  };

  useEffect(() => {
    focusNext?.target()?.focus();
  }, [focusNext]);

  useLayoutEffect(() => {
    const box = pane.current;
    if (!box) return;
    if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && olderPlace?.botId === botId && olderPlace.oldest !== messages[0]?.id) {
      box.scrollTo({ top: box.scrollHeight - olderPlace.fromEnd, behavior: "instant" });
      olderPlace = null;
      olderMoved = true;
      return;
    }
    box.scrollTop = box.scrollHeight;
  }, [messages.length, waiting.length, working === null]);

  useEffect(() => {
    const box = pane.current;
    const thread = list.current;
    if (!box || !thread) return;
    let known = 0;
    let seen = 0;
    const onScroll = () => {
      const height = __QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && olderMoved ? box.scrollHeight : Math.min(known, box.scrollHeight);
      if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") olderMoved = false;
      stuck.current = height - Math.max(seen, box.clientHeight) - box.scrollTop <= 48;
    };
    const watcher = new ResizeObserver(() => {
      if (stuck.current) box.scrollTop = box.scrollHeight;
      known = box.scrollHeight;
      seen = box.clientHeight;
    });
    watcher.observe(box);
    watcher.observe(thread);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      watcher.disconnect();
      box.removeEventListener("scroll", onScroll);
    };
  }, [world !== null && bot !== null]);

  useEffect(() => {
    const box = cards.current;
    if (!box) return;
    const size = () => (box.offsetHeight && box.parentElement ? box.offsetHeight + (parseFloat(getComputedStyle(box.parentElement).rowGap) || 0) : 0);
    let last = size();
    const watcher = new ResizeObserver(() => {
      const next = size();
      if (!stuck.current && next !== last) pane.current?.scrollBy(0, next - last);
      last = next;
    });
    watcher.observe(box);
    return () => watcher.disconnect();
  }, [world !== null && bot !== null]);

  useEffect(() => {
    document.title = bot ? bot.name + " · Quarterdeck" : "Quarterdeck";
  }, [bot]);

  if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on")
    useEffect(() => {
      if (!draft.quote || !thread.value || canReply) return;
      const text = isCardQuote(draft.quote) ? withCardLine(draft.text, draft.quote) : draft.text;
      setDraft({ text, quote: null, files: [] });
    }, [draft.quote, !thread.value, canReply]);

  useEffect(() => {
    const done = pending.filter((p) => sentIds.has(p.clientId));
    if (!done.length) return;
    setPending((list) => list.filter((p) => !sentIds.has(p.clientId)));
    for (const item of done) for (const preview of item.previews) URL.revokeObjectURL(preview.url);
  }, [thread.value?.messages]);

  const deliver = (item: PendingSend) => {
    setPending((list) => (list.some((p) => p.clientId === item.clientId) ? list.map((p) => (p.clientId === item.clientId ? { ...item, failed: false } : p)) : [...list, { ...item, failed: false }]));
    thread.send({ text: item.text, clientId: item.clientId, quote: item.quote ?? undefined, files: item.files }).catch((error: unknown) => {
      const refused = __QD_SOURCE__ === "server" && __QD_CHAT__ === "on" ? refusal(error) : {};
      setPending((list) => list.map((p) => (p.clientId === item.clientId ? { ...p, failed: true, ...refused } : p)));
    });
  };

  const send = (): boolean => {
    const text = draft.text.trim();
    if (!text && !draft.files.length) return false;
    if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") {
      if (!thread.value) return false;
      if (!withinLimit(text)) {
        setRefused([SEND_LONG_TEXT]);
        return false;
      }
    }
    deliver({
      clientId: crypto.randomUUID(),
      text,
      quote: draft.quote,
      files: draft.files.map((item) => item.file),
      previews: draft.files.map((item) => ({ id: item.id, name: item.file.name, size: item.file.size, type: item.file.type, url: item.url })),
      failed: false,
      at: new Date(qd.now()).toISOString(),
      after: waiting[waiting.length - 1]?.clientId ?? messages[messages.length - 1]?.id ?? null,
    });
    setRefused([]);
    setDraft({ text: "", quote: null, files: [] });
    return true;
  };

  const attach = (list: File[]) => {
    const owner = botId;
    void attachChatFiles(owner, list, admit).then(
      (reasons) => { if (activeBot.current === owner) setRefused(reasons); },
      () => { if (activeBot.current === owner) setRefused(["Could not read these files."]); },
    );
  };

  const unattach = (id: string) => {
    const at = draft.files.findIndex((item) => item.id === id);
    if (at < 0) return;
    URL.revokeObjectURL(draft.files[at].url);
    const next = draft.files[at + 1] ?? draft.files[at - 1];
    if (document.activeElement?.matches(":focus-visible")) setFocusNext({ target: () => (next ? (root.current?.querySelector<HTMLElement>(`[data-remove="${next.id}"]`) ?? null) : input.current) });
    setDraft({ ...draft, files: draft.files.filter((item) => item.id !== id) });
  };

  const quoteMessage = (message: ChatMessage, selected: string | null) => {
    setDraft({ ...draft, quote: messageQuote({ id: message.id, who: message.from === "bot" ? (bot?.name ?? "Bot") : "You", at: message.at, text: message.text, selected }) });
    setFocusNext({ target: () => input.current });
  };

  const head = (
    <>
      <link rel="stylesheet" href="/chat.css" precedence="chat" />
      <ChatHeader botId={botId} bot={bot} choices={choices} />
    </>
  );

  if (!world || !bot)
    return (
      <div className="chat-view flex min-h-dvh flex-col">
        {head}
        <div className="chat-empty mx-auto w-full px-4 pt-5">
          {world ? __QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && !thread.failed ? <LoadingBars rows={3} height={80} /> : <Empty>No chat with this bot.</Empty> : <LoadingBars rows={3} height={80} />}
        </div>
      </div>
    );

  const days = new Set<string>();
  const dayRow = (at: string) => {
    const key = dayKey(at);
    if (days.has(key)) return [];
    days.add(key);
    return [
      <li key={"day-" + key} className="chat-day">
        {dayLabel(at)}
      </li>,
    ];
  };
  const sends = new Set<string>();
  const waitingRows = (items: PendingSend[]) =>
    items.flatMap((item) => [
      ...dayRow(item.at),
      <MyMessage key={"send-" + item.clientId} text={item.text} quote={item.quote} attachments={item.previews} at={item.at} note={item.failed ? "failed" : "sending"} reason={item.reason} onRetry={item.retry === false ? undefined : () => deliver(item)} onOpen={open} world={world} rise />,
    ]);
  const known = new Map(messages.flatMap((message, n): [string, number][] => (message.clientId ? [[message.id, n], [message.clientId, n]] : [[message.id, n]])));
  const out = new Map(waiting.map((item) => [item.clientId, item]));
  const spot = (item: PendingSend): number => {
    if (item.after === null) return -1;
    const before = out.get(item.after);
    return known.get(item.after) ?? (before ? spot(before) : messages.length);
  };
  const chain = (anchor: string | null): PendingSend[] => waiting.filter((item) => item.after === anchor).flatMap((item) => [item, ...chain(item.clientId)]);
  const later = waiting.some((item) => !item.failed || spot(item) >= latest);
  const top = waitingRows(chain(null));
  const timeline = [
    ...messages.map((message, n) => ({ at: message.at, message, n })),
    ...secrets.requests.filter((request) => request.status === "asking").map((request) => ({ at: request.at, request })),
    ...secrets.events.map((event) => ({ at: event.at, event })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const rows = timeline.flatMap((entry) => {
    const sep = dayRow(entry.at);
    if ("request" in entry)
      return [
        ...sep,
        <li key={"request-" + entry.request.id} className="chat-secret">
          <SecretCard botId={botId} botName={bot.name} request={entry.request} ready={secretsReady} />
        </li>,
      ];
    if ("event" in entry) return [...sep, <SecretLine key={"event-" + entry.event.id} event={entry.event} botName={bot.name} />];
    const { message, n } = entry;
    const mark = message.id === newId ? [<NewLine key="new-line" />] : [];
    const under = waitingRows(chain(message.id));
    if (message.from === "bot") return [...sep, ...mark, <BotMessage key={"message-" + message.id} message={message} name={bot.name} color={bot.color} world={world} fresh={fresh.has(message.id)} onQuote={canReply ? (selected) => quoteMessage(message, selected) : undefined} onOpen={open} />, ...under];
    const sendId = message.clientId;
    const own = sendId !== undefined && !sends.has(sendId);
    if (own) sends.add(sendId);
    return [
      ...sep,
      ...mark,
      <MyMessage
        key={own ? "send-" + sendId : "message-" + message.id}
        id={message.id}
        text={message.text}
        quote={message.quote}
        attachments={message.attachments}
        at={message.at}
        note={n === latest && !later ? (seenAt >= latest ? "read" : "delivered") : null}
        seenAt={thread.value?.seenAt}
        onOpen={open}
        world={world}
        botName={bot.name}
        actions={canReply && message.text ? (selected) => quoteMessage(message, selected) : undefined}
        rise={fresh.has(message.id)}
      />,
      ...under,
      ...(own ? waitingRows(chain(sendId)) : []),
    ];
  });
  rows.push(...waitingRows(waiting.filter((item) => item.after !== null && !known.has(item.after) && !out.has(item.after)).flatMap((item) => [item, ...chain(item.clientId)])));
  rows.unshift(...top);
  if (newId !== null && thread.value?.older && !messages.some((message) => message.id === newId)) rows.unshift(<NewLine key="new-line" />);

  return (
    <div
      ref={root}
      className="chat-view flex h-svh flex-col md:h-dvh"
      data-testid="chat"
      onDragEnter={(event) => {
        if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") return;
        if (!carriesFiles(event)) return;
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => carriesFiles(event) && event.preventDefault()}
      onDragLeave={(event) => {
        if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") return;
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") return;
        depth.current = 0;
        setDragging(false);
        attach([...event.dataTransfer.files]);
      }}
    >
      {head}
      <div ref={pane} className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain" data-testid="chat-scroll">
        <ol ref={list} className="chat-timeline mx-auto flex w-full flex-col pointer-coarse:select-none pointer-coarse:[&_input]:select-text pointer-coarse:[&_textarea]:select-text" aria-label={"Chat with " + bot.name} data-testid="chat-thread">
          {thread.failed && !thread.value ? (
            <li>
              <ErrorLine onRetry={thread.retry}>Could not load this chat.</ErrorLine>
            </li>
          ) : !thread.value ? (
            <li>
              <LoadingBars rows={3} height={80} />
            </li>
          ) : (
            <>
              {__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" ? (
                <>
                  {thread.value.older && <OlderRow botId={botId} oldest={messages[0]?.id} pane={pane} />}
                  {!messages.length && (
                    <li>
                      <Empty>No messages yet.</Empty>
                    </li>
                  )}
                  {rows}
                </>
              ) : (
                rows
              )}
              {working && <WorkingLine botName={bot.name} working={working} />}
              {secrets.loading && (
                <li>
                  <LoadingBars rows={1} height={44} />
                </li>
              )}
              {secrets.failed && (
                <li>
                  <ErrorLine onRetry={secrets.retry}>Could not load this chat's secret requests.</ErrorLine>
                </li>
              )}
              {boxOpen && (
                <li>
                  <SecretCard
                    botId={botId}
                    botName={bot.name}
                    ready={secretsReady}
                    onClose={() => {
                      setBoxOpen(false);
                      input.current?.focus();
                    }}
                  />
                </li>
              )}
            </>
          )}
        </ol>
      </div>
      <Composer
        botName={bot.name}
        world={world}
        draft={draft}
        onDraft={setDraft}
        onSend={send}
        inputRef={input}
        onAttach={attach}
        onUnattach={unattach}
        notice={refused.length ? refused.join(" ") : null}
        onDismissNotice={() => setRefused([])}
        onSecret={() => setBoxOpen(true)}
        onUseSecretBox={() => setBoxOpen(true)}
        cards={
          <div ref={cards} className="chat-dock-cards">
            {arrival && (
              <Arrival from={arrival} onDismiss={dismissArrival}>
                {choices}
              </Arrival>
            )}
            {canReply && draft.quote && (
              <QuoteBlock
                quote={draft.quote}
                onRemove={() => {
                  if (document.activeElement?.matches(":focus-visible")) setFocusNext({ target: () => input.current });
                  setDraft({ ...draft, quote: null });
                }}
              />
            )}
          </div>
        }
      />
      {canReply && (
        <SelectionQuote
          onQuote={(id, text) => {
            const message = messages.find((item) => item.id === id);
            if (message) quoteMessage(message, text);
          }}
        />
      )}
      {viewing && <FileViewer file={viewing} returnTo={opener} onClose={() => setViewing(null)} />}
      {gallery !== null && <Viewer items={pictures} start={gallery} label="Pictures in this chat" returnTo={opener} onClose={() => setGallery(null)} caption={(item) => item.caption} />}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 grid place-items-center bg-scrim" data-testid="drop-hint">
          <p role="status" className="rounded-panel border border-line-3 bg-panel px-5 py-3 text-body">
            Drop to attach to {bot.name}
          </p>
        </div>
      )}
    </div>
  );
}
