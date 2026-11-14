import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQd } from "../../data/hooks";
import { checkSecretName, SECRET_TEXT, secretText, savedLine, type SecretEvent, type SecretRequest } from "../../domain/secrets";
import { Button, IconButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";

const FIELD = "block min-h-s7 w-full min-w-0 rounded-key border border-line bg-page px-s3 py-s3 text-body leading-snug text-ink outline-none focus:border-line-3";

const NO_MANAGER = { "data-1p-ignore": "", "data-lpignore": "true", "data-form-type": "other" };

function BotWords({ words, mono, testId }: { words: { label: string; quote: string }; mono?: boolean; testId: string }) {
  return (
    <figure className="grid gap-hair text-meta" data-testid={testId}>
      <figcaption className="text-ink-2">{words.label}</figcaption>
      <blockquote className={cx("border-l-2 border-line-3 pl-s2 text-ink [overflow-wrap:anywhere]", mono && "font-mono")}>{words.quote}</blockquote>
    </figure>
  );
}

export function SecretCard({ botId, botName, request, ready, onClose }: { botId: string; botName: string; request?: SecretRequest; ready: boolean; onClose?: () => void }) {
  const { secrets } = useQd();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [key] = useState(() => botId + ":" + Date.now() + ":" + Math.random());
  const nameField = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const noteId = useId();

  useEffect(() => {
    if (!request) nameField.current?.focus();
  }, [request]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !value || !ready) return;
    if (!request) {
      const check = checkSecretName(name);
      if (!check.ok) {
        setProblem(check.reason);
        nameField.current?.focus();
        return;
      }
    }
    setBusy(true);
    setProblem(null);
    try {
      await secrets.save(request ? { kind: "request", requestId: request.id, key } : { kind: "direct", name, key }, value);
      onClose?.();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : SECRET_TEXT.saveFailed);
      setBusy(false);
    }
  };

  const decline = () => {
    if (!request || busy) return;
    try {
      secrets.decline(request.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : secretText.ended(botName));
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
      className="chat-secret-card grid gap-s2 rounded-panel border border-line-3 bg-panel p-s3"
      data-testid={request ? "secret-request" : "secret-box"}
    >
      <div className="flex items-center gap-s2">
        <Icon name="lock" size="sm" className="flex-none text-ink-2" />
        <h3 id={titleId} className="min-w-0 flex-1 text-body font-strong [overflow-wrap:anywhere]">
          {secretText.card(botName)}
        </h3>
        {onClose && <IconButton icon="x" label="Close the secret box" onClick={onClose} />}
      </div>
      {request ? (
        <>
          <BotWords words={secretText.suggestedName(request.name)} mono testId="secret-name" />
          <BotWords words={secretText.reason(botName, request.reason)} testId="secret-reason" />
        </>
      ) : (
        <label className="grid gap-s1 text-meta text-ink-2">
          Name
          <input
            ref={nameField}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={hintId}
            className={FIELD}
            data-testid="secret-name-field"
            {...NO_MANAGER}
          />
          <span id={hintId}>{SECRET_TEXT.nameHint}</span>
        </label>
      )}
      <form onSubmit={save} className="flex flex-wrap items-center gap-s2" autoComplete="off">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={"Secret value for " + botName}
          aria-describedby={noteId}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
          className={FIELD + " flex-[1_1_220px] font-mono"}
          data-testid="secret-value"
          {...NO_MANAGER}
        />
        <Button type="submit" kind="primary" disabled={busy || !value || !ready} data-testid="secret-save">
          {SECRET_TEXT.save}
        </Button>
        {request && (
          <Button kind="ghost" disabled={busy} onClick={decline} data-testid="secret-decline">
            {SECRET_TEXT.decline}
          </Button>
        )}
      </form>
      {problem && (
        <p role="alert" className="text-meta text-stop [overflow-wrap:anywhere]" data-testid="secret-problem">
          {problem}
        </p>
      )}
      <p id={noteId} className="text-meta text-ink-2" data-testid="secret-note">
        {secretText.note}
      </p>
    </section>
  );
}

export function SecretLine({ event, botName }: { event: SecretEvent; botName: string }) {
  return (
    <li className="flex items-start gap-s1 self-center text-meta text-ink-2 [overflow-wrap:anywhere]" data-testid="secret-line">
      <Icon name="lock" size="xs" className="mt-hair flex-none" />
      {event.kind === "saved" ? savedLine(event, botName) : event.kind === "declined" ? SECRET_TEXT.declined : secretText.ended(botName)}
    </li>
  );
}
