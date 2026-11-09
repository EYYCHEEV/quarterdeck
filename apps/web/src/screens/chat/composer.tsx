import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode, type RefObject } from "react";
import type { ChatDraft } from "../../data/session";
import { looksLikeSecret, SECRET_TEXT } from "../../domain/secrets";
import type { World } from "../../domain/types";
import { enterSends, pageKey, watchKeyboard, type KeyboardWatch } from "../../platform/keyboard";
import { useFilePicker, type PickSource } from "../../platform/pick-files";
import { Button } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Icon, type IconName } from "../../ui/icon";
import { useOverlay } from "../../ui/overlay";
import { ErrorLine } from "../../ui/states";
import { DraftStrip } from "./attachments";

type Ref = { code: string; title: string; kind: string };

function references(world: World): Ref[] {
  return [
    ...world.mail.flatMap((t) => [{ code: t.ref, title: t.subject, kind: "Mail" }, ...t.mails.map((m) => ({ code: m.ref, title: m.from + " to " + m.to.join(", "), kind: "Mail" }))]),
    ...world.pages.map((p) => ({ code: p.ref, title: p.title, kind: "Page" })),
    ...world.artifacts.map((a) => ({ code: a.ref, title: a.name, kind: "Artifact" })),
  ];
}

function CiteMenu({ refs, onPick, onClose }: { refs: Ref[]; onPick: (code: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose);
  return (
    <>
      <div className="fixed inset-0 z-20" aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-label="Cite a reference"
        tabIndex={-1}
        data-pop="cite"
        className="absolute inset-x-0 bottom-[calc(100%+8px)] z-30 grid max-h-[50vh] gap-0.5 overflow-y-auto rounded-panel border border-line-2 bg-control p-2 shadow-pop outline-none"
      >
        <p className="eyebrow px-2 py-1.5">Cite a reference</p>
        {refs.map((ref, n) => (
          <button
            key={ref.code}
            type="button"
            data-autofocus={n === 0 ? "" : undefined}
            onClick={() => onPick(ref.code)}
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-note hover:bg-raised"
            data-testid="cite-item"
          >
            <code className="flex-none font-mono text-xs text-ink">{ref.code}</code>
            <span className="min-w-0 [overflow-wrap:anywhere] text-ink-2">{ref.title}</span>
            <span className="ml-auto flex-none text-xs text-ink-3">{ref.kind}</span>
          </button>
        ))}
      </div>
    </>
  );
}

type MenuId = PickSource | "secret";
type Source = { id: MenuId; label: string; icon: IconName };

const SOURCES: Source[] = [
  { id: "photos", label: "Photos", icon: "picture" },
  { id: "camera", label: "Camera", icon: "camera" },
  { id: "files", label: "Files", icon: "file" },
  { id: "secret", label: "Secret", icon: "lock" },
];

function PlusMenu({ onPick, onClose }: { onPick: (id: MenuId) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose);
  return (
    <>
      <div className="fixed inset-0 z-20" aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-label="Add to the message"
        tabIndex={-1}
        data-pop="plus"
        className="absolute bottom-[calc(100%+8px)] left-0 z-30 grid w-56 gap-0.5 rounded-panel border border-line-2 bg-control p-2 shadow-pop outline-none"
      >
        {SOURCES.map((source, n) => (
          <button
            key={source.id}
            type="button"
            data-autofocus={n === 0 ? "" : undefined}
            onClick={() => onPick(source.id)}
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-body hover:bg-raised"
            data-testid={"plus-" + source.id}
          >
            <Icon name={source.icon} size="sm" className="text-ink-2" />
            {source.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function Composer({
  botName,
  world,
  draft,
  onDraft,
  onSend,
  onPage,
  cards,
  inputRef,
  onAttach,
  onUnattach,
  notice,
  onDismissNotice,
  onSecret,
  onUseSecretBox,
}: {
  botName: string;
  world: World;
  draft: ChatDraft;
  onDraft: (draft: ChatDraft) => void;
  onSend: () => boolean;
  onPage: (direction: -1 | 1) => void;
  cards: ReactNode;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onAttach: (files: File[]) => void;
  onUnattach: (id: string) => void;
  notice: string | null;
  onDismissNotice: () => void;
  onSecret: () => void;
  onUseSecretBox?: () => void;
}) {
  const cite = useRef<HTMLButtonElement>(null);
  const caret = useRef<number | null>(null);
  const picker = useFilePicker(onAttach);
  const [citing, setCiting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pasteBlocked, setPasteBlocked] = useState(false);
  const [pasteNotice, setPasteNotice] = useState<"again" | "unavailable" | null>(null);
  const pasteBypass = useRef(false);
  const keyboard = useRef<KeyboardWatch | null>(null);
  const ready = draft.text.trim().length > 0 || draft.files.length > 0;

  useEffect(() => {
    const watch = watchKeyboard(window);
    keyboard.current = watch;
    return () => {
      watch.stop();
      keyboard.current = null;
    };
  }, []);

  const submit = () => {
    if (!ready || !onSend()) return;
    if (keyboard.current?.up() && window.matchMedia("(min-width: 640px)").matches) inputRef.current?.blur();
  };

  const clearPaste = useCallback(() => {
    pasteBypass.current = false;
    setPasteBlocked(false);
    setPasteNotice(null);
  }, []);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPaste();
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("popstate", clearPaste);
    window.addEventListener("hashchange", clearPaste);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("popstate", clearPaste);
      window.removeEventListener("hashchange", clearPaste);
    };
  }, [clearPaste]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    const form = el?.form;
    if (!el || !form) return;
    form.style.minHeight = form.offsetHeight + "px";
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.matchMedia("(min-width: 640px)").matches ? 208 : 160) + "px";
    form.style.minHeight = "";
  }, [draft.text, inputRef]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || caret.current === null) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [draft.text, inputRef]);

  const insert = (code: string) => {
    const el = inputRef.current;
    const at = el?.selectionStart ?? draft.text.length;
    const end = el?.selectionEnd ?? at;
    const before = draft.text.slice(0, at);
    const after = draft.text.slice(end);
    const piece = (before && !/\s$/.test(before) ? " " : "") + code + (after.startsWith(" ") ? "" : " ");
    caret.current = before.length + piece.length;
    setCiting(false);
    onDraft({ ...draft, text: before + piece + after });
  };

  const pickSource = (id: MenuId) => {
    setAdding(false);
    if (id === "secret") return onSecret();
    picker.open(id);
  };

  const pasted = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const bypass = pasteBypass.current;
    clearPaste();
    const text = event.clipboardData.getData("text/plain");
    if (!bypass && looksLikeSecret(text)) {
      event.preventDefault();
      setAdding(false);
      setCiting(false);
      setPasteBlocked(true);
      return;
    }
    if (text) return;
    if (__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") return;
    const list = [...event.clipboardData.files];
    if (list.length) {
      event.preventDefault();
      onAttach(list);
    }
  };

  const round = "grid size-11 flex-none cursor-pointer place-items-center rounded-full text-ink-2 hover:bg-raised hover:text-ink";

  return (
    <div className="chat-composer-dock">
      <div className="chat-composer-inner">
        {notice && (
          <ErrorLine onRetry={onDismissNotice} retryLabel="Dismiss">
            {notice}
          </ErrorLine>
        )}
        {pasteBlocked && (
          <div data-testid="secret-paste-warning">
            <ErrorLine onRetry={() => { clearPaste(); inputRef.current?.focus(); }} retryLabel="Cancel">
              <span className="grid gap-2">
                <span>{SECRET_TEXT.pasteWarning}</span>
                <span className="flex flex-wrap gap-2">
                  {!(__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") && (
                    <Button
                      onClick={() => {
                        clearPaste();
                        if (onUseSecretBox) onUseSecretBox();
                        else {
                          setPasteNotice("unavailable");
                          inputRef.current?.focus();
                        }
                      }}
                    >
                      {SECRET_TEXT.useSecretBox}
                    </Button>
                  )}
                  <Button
                    kind="ghost"
                    onClick={() => {
                      setPasteBlocked(false);
                      pasteBypass.current = true;
                      setPasteNotice("again");
                      inputRef.current?.focus();
                    }}
                  >
                    {SECRET_TEXT.sendAnyway}
                  </Button>
                </span>
              </span>
            </ErrorLine>
          </div>
        )}
        {pasteNotice && (
          <div data-testid="secret-paste-notice">
            <ErrorLine onRetry={() => { clearPaste(); inputRef.current?.focus(); }} retryLabel="Dismiss">
              {pasteNotice === "again" ? SECRET_TEXT.pasteAgain : SECRET_TEXT.unavailable}
            </ErrorLine>
          </div>
        )}
        {cards}
        <form
          className="chat-composer-form relative min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {draft.files.length > 0 && <DraftStrip files={draft.files} onRemove={onUnattach} />}
          <div className="chat-composer-row">
            {!(__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") && (
              <button
                type="button"
                aria-expanded={adding}
                aria-label="Add photos, files or a secret"
                title="Add photos, files or a secret"
                onClick={() => setAdding(!adding)}
                className={cx(round, adding && "bg-raised text-ink")}
                data-testid="plus-btn"
              >
                <Icon name="plus" />
              </button>
            )}
            {!(__QD_SOURCE__ === "server" && __QD_CHAT__ === "on") && adding && <PlusMenu onPick={pickSource} onClose={() => setAdding(false)} />}
            <button
              ref={cite}
              type="button"
              aria-expanded={citing}
              aria-label="Cite a mail, Page or Artifact reference"
              title="Cite a reference"
              onClick={() => setCiting(!citing)}
              className={cx(round, citing && "bg-raised text-ink")}
              data-testid="cite-btn"
            >
              <Icon name="at" />
            </button>
            {citing && <CiteMenu refs={references(world)} onPick={insert} onClose={() => setCiting(false)} />}
            <textarea
              ref={inputRef}
              rows={1}
              value={draft.text}
              placeholder={"Message " + botName}
              aria-label={"Message " + botName}
              onChange={(event) => onDraft({ ...draft, text: event.target.value })}
              onPaste={pasted}
              enterKeyHint="enter"
              onKeyDown={(event) => {
                const direction = pageKey(event.nativeEvent, event.currentTarget);
                if (direction !== 0) {
                  event.preventDefault();
                  onPage(direction);
                  return;
                }
                if (!enterSends(event.nativeEvent, keyboard.current?.up() ?? false)) return;
                event.preventDefault();
                submit();
              }}
              className="chat-compose-input min-h-11 min-w-0 flex-1 border-0 bg-transparent text-base leading-[1.4] text-ink outline-none"
              data-testid="chat-input"
            />
            <button
              type="submit"
              disabled={!ready}
              onPointerDown={(event) => event.pointerType === "mouse" && event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              aria-label="Send"
              title="Send"
              className={cx("chat-send grid size-11 flex-none cursor-pointer place-items-center rounded-full disabled:cursor-default", ready ? "chat-accent-fill" : "bg-raised text-ink-3")}
              data-testid="chat-send"
            >
              <Icon name="send" />
            </button>
          </div>
          {picker.inputs}
        </form>
      </div>
    </div>
  );
}
