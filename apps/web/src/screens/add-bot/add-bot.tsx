import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useBotsAdmin, useBotsApi, type BotsAdmin, type BotsApi, type JoinedBot, type PendingJoin } from "../../data/bots-hooks";
import type { BotsNotice, MadeInvite } from "../../data/source";
import { BOTS_WORDS } from "../../domain/bot-joins";
import { href } from "../../domain/routes";
import { Avatar } from "../../ui/avatar";
import { Button, IconButton } from "../../ui/button";
import { useCopy } from "../../ui/copy";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { PasswordField } from "../../ui/password-field";
import { SheetDialog } from "../../ui/sheet-dialog";
import { ErrorLine } from "../../ui/states";

function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="eyebrow">{label}</p>
      {children}
    </div>
  );
}

function NameStep({ name, onName, onCreate, busy, notice }: { name: string; onName: (name: string) => void; onCreate: () => void; busy: boolean; notice: BotsNotice | null }) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate();
  };
  return (
    <form onSubmit={submit} className="grid gap-3" data-testid="bot-name-step">
      <label className="grid gap-1.5">
        <span className="text-meta font-medium text-ink-2">Name (optional)</span>
        <input
          value={name}
          onChange={(event) => onName(event.target.value)}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          placeholder="Any bot"
          data-autofocus=""
          data-testid="bot-name"
          className="min-h-12 w-full rounded-control border border-line-3 bg-well px-3.5 text-base text-ink outline-none focus:border-brass"
        />
      </label>
      <p className="text-small text-ink-2">Only a bot with this name can use the invite.</p>
      {notice && (
        <ErrorLine onRetry={notice.again ? onCreate : undefined} retryLabel="Try again">
          {notice.words}
        </ErrorLine>
      )}
      <div className="flex justify-end">
        <Button kind="primary" type="submit" disabled={busy} className="sheet-act">
          Create invite
        </Button>
      </div>
    </form>
  );
}

function RequestStep({ request, needsPassword, onApprove, onRefuse }: { request: PendingJoin; needsPassword: boolean; onApprove: () => void; onRefuse: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <>
      <div className="grid gap-1 rounded-panel border border-line-3 bg-well px-4 py-4 text-center">
        <p className="text-meta text-ink-2">Code shown by the bot:</p>
        <p className="join-code font-mono font-bold text-ink" data-testid="join-code">
          {request.code}
        </p>
        <p className="text-meta text-ink-2">Check your bot shows the same code.</p>
      </div>
      <p className="text-body text-ink">
        <b className="font-semibold">Once in:</b> mail any bot, chat with you, use quarterdeck-mcp.
      </p>
      {needsPassword && <PasswordField value={password} onText={setPassword} />}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <Button kind="plain" onClick={onRefuse} data-testid="join-refuse">
          Refuse
        </Button>
        <Button kind="primary" disabled={needsPassword && password.length === 0} onClick={onApprove} data-testid="join-approve">
          Approve
        </Button>
      </div>
    </>
  );
}

function JoinedStep({ bot, onClose }: { bot: JoinedBot; onClose: () => void }) {
  return (
    <>
      <div className="flex items-center gap-3 rounded-panel border border-line-3 bg-well px-4 py-3.5" data-testid="joined-row">
        <Avatar name={bot.name} color="var(--color-avatar-1)" size="xl" />
        <span className="min-w-0 flex-1">
          <b className="block text-row font-semibold">{bot.name}</b>
          <span className="block text-small text-ink-2">In your sidebar now</span>
        </span>
        <span className="size-[9px] flex-none rounded-full bg-brass" role="img" aria-label="New" />
      </div>
      <Link
        to={href.chat(bot.id)}
        onClick={onClose}
        className="brass-fill inline-flex min-h-12 items-center justify-center gap-2 rounded-control px-[18px] text-body font-semibold"
        data-testid="joined-chat"
      >
        Chat with {bot.name}
        <Icon name="chevR" size="sm" />
      </Link>
    </>
  );
}

export function AddBotDialog({ onClose, returnTo }: { onClose: () => void; returnTo: RefObject<HTMLElement | null> }) {
  const api = useBotsApi();
  const admin = useBotsAdmin();
  return (
    <SheetDialog label="Add bot" pop="add-bot" wide onClose={onClose} returnTo={returnTo}>
      {api && admin ? (
        <AddBot api={api} admin={admin} onClose={onClose} />
      ) : (
        <>
          <Top title="Add bot" sub={null} waiting={false} onClose={onClose} />
          <div className="sheet-body px-5 pt-3">
            <ErrorLine>Could not load the bots.</ErrorLine>
          </div>
        </>
      )}
    </SheetDialog>
  );
}

function Top({ title, sub, waiting, onClose }: { title: string; sub: string | null; waiting: boolean; onClose: () => void }) {
  return (
    <div className="sheet-top flex flex-none items-start gap-3 px-5 pb-1">
      <div className="min-w-0 flex-1" role="status" data-testid={waiting ? "bot-waiting" : undefined}>
        <h2 className="text-title leading-[1.25] font-bold tracking-[-.01em] [overflow-wrap:anywhere]">{title}</h2>
        {sub && <p className="mt-1 text-meta text-ink-2">{sub}</p>}
      </div>
      <IconButton icon="x" label="Close Add bot" onClick={onClose} className="rounded-full bg-control" data-testid="add-bot-close" />
    </div>
  );
}

function AddBot({ api, admin, onClose }: { api: BotsApi; admin: BotsAdmin; onClose: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<MadeInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [joinedBot, setJoinedBot] = useState<JoinedBot | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const { copy, state } = useCopy(1600);
  const copyButton = useRef<HTMLButtonElement>(null);

  const invite = made?.invite ?? null;
  const request = invite ? admin.pending.find((join) => join.inviteId === invite.id) : undefined;
  const bot = invite?.forName ?? "your bot";
  const phase = joinedBot ? "joined" : refused ? "refused" : request ? "request" : copied ? "waiting" : invite ? "invite" : "name";

  useEffect(() => {
    if (phase === "invite") copyButton.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    api.clearNotice();
    return api.clearNotice;
  }, [api]);

  const create = async () => {
    if (admin.busy) return;
    const result = await api.createInvite(name);
    if (result) setMade(result);
  };
  const doCopy = () => {
    if (made) copy(made.prompt);
    if (!copied && invite) api.askLater(invite.id);
    setCopied(true);
  };
  const cancel = () => {
    if (invite) void api.cancelInvite(invite.id);
    onClose();
  };

  const heading: Record<typeof phase, [string, string | null]> = {
    name: ["Add bot", null],
    invite: ["Copy this invite now", "Works once, for 24 hours. Shown only now."],
    waiting: admin.approveHere ? ["Waiting for " + bot + " to ask to join...", "Invite copied. It works once, for 24 hours."] : ["Waiting for " + bot + " to ask to join.", BOTS_WORDS.waiting],
    request: [(request?.name ?? bot) + " wants to join", "Invited by " + (request?.invitedBy ?? "you") + ", " + (request?.at ?? "")],
    joined: [(joinedBot?.name ?? bot) + " joined.", null],
    refused: ["Refused. " + (refused ?? bot) + " was not added.", null],
  };
  const [title, sub] = heading[phase];

  return (
    <>
      <Top title={title} sub={sub} waiting={phase === "waiting"} onClose={onClose} />
      <div className="sheet-body grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-5 pt-3">
        {phase === "name" && <NameStep name={name} onName={setName} onCreate={() => void create()} busy={admin.busy} notice={admin.notice} />}
        {phase === "invite" && made && (
          <Step label="Invite">
            <p className="rounded-control border border-line-3 bg-well px-3.5 py-3 font-mono text-code leading-[1.6] text-code-ink [overflow-wrap:anywhere] select-all" data-testid="bot-prompt">
              {made.prompt}
            </p>
            {made.code !== null && (
              <p className="text-meta text-ink-2" data-testid="invite-code">
                Invite code: {made.code}
              </p>
            )}
            <Button ref={copyButton} kind="primary" onClick={doCopy} data-testid="invite-copy" className="sheet-act-end">
              <Icon name="copy" size="sm" />
              Copy
            </Button>
            <p role="status" className="flex items-center gap-2 border-t border-line pt-3 text-meta text-ink-2" data-testid="bot-waiting-line">
              <Icon name="clock" size="sm" className="text-ink-3" />
              Waiting for {bot} to ask to join...
            </p>
          </Step>
        )}
        {phase === "waiting" && (
          <Step label="Invite">
            <div className="flex items-center gap-3 rounded-control border border-line bg-control px-3.5 py-3">
              <Icon name="check" size="sm" className="text-green" />
              <span className="min-w-0 flex-1 text-meta text-ink-2">Copied. The text is not shown again.</span>
              <Button kind="ghost" onClick={doCopy} className="min-h-11 px-3 py-0 text-meta">
                Copy again
              </Button>
            </div>
            <Button kind="ghost" onClick={cancel} className="sheet-act-start" data-testid="invite-cancel">
              Cancel invite
            </Button>
          </Step>
        )}
        {phase === "request" && request && (
          <RequestStep
            request={request}
            needsPassword={admin.password}
            onApprove={() => void api.approveJoin(request.id).then(setJoinedBot)}
            onRefuse={() => {
              void api.refuseJoin(request.id);
              setRefused(request.name);
            }}
          />
        )}
        {phase === "joined" && joinedBot && <JoinedStep bot={joinedBot} onClose={onClose} />}
        {phase === "refused" && (
          <Button kind="plain" onClick={onClose} className="sheet-act-end">
            Close
          </Button>
        )}
      </div>
      {state === "copied" && (
        <p role="status" className="sheet-toast pointer-events-none fixed inset-x-0 mx-auto w-fit rounded-full border border-line-3 bg-raised px-4 py-2 text-meta text-ink" data-testid="toast">
          Copied
        </p>
      )}
    </>
  );
}
