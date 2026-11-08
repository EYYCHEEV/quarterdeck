import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBotsAdmin, useBotsApi, type BotNote, type BotsAdmin, type BotsApi, type CleanupDays, type HistoryLine, type PendingJoin } from "../../data/bots-hooks";
import { useQd, useWorld } from "../../data/hooks";
import { saveSettings, useSettings, type Appearance } from "../../data/settings";
import { BOTS_WORDS, endsText } from "../../domain/bot-joins";
import { href, type SettingsSection } from "../../domain/routes";
import type { Bot } from "../../domain/types";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { cx } from "../../ui/cx";
import { PasswordField } from "../../ui/password-field";
import { FLOAT_TOP_PAD, FloatAction, FloatCapsule, FloatTop } from "../../ui/float";
import { FloatBack } from "../../ui/float-back";
import { BackLink, Head, useFrame } from "../../ui/head";
import { Icon } from "../../ui/icon";
import { useKeys } from "../../ui/keys";
import { go, Link } from "../../ui/link";
import { MoreSheet } from "../../ui/more-sheet";
import { ChoiceRow } from "../../ui/option";
import { usePhone } from "../../ui/phone";
import { ErrorLine, LoadingBars } from "../../ui/states";
import { SignOutConfirm } from "./account";
import { CleanupDialog, RemoveBotDialog } from "./dialogs";

const APPEARANCE: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

const TITLES: Record<SettingsSection, string> = { bots: "Bots", appearance: "Appearance", "add-ons": "Add-ons", storage: "Storage", account: "Account" };

const SECTIONS: SettingsSection[] = ["bots", "appearance", "add-ons", "storage", "account"];

const SCREENS: Record<string, string> = { queue: "Queue", lanes: "Lane", projects: "Projects", chat: "Chat", mail: "Mail" };

function screenName(path: string): string {
  const [head, , kind, ref] = path.split("/").filter(Boolean);
  if (head === "projects" && kind) return kind === "artifacts" ? "Artifact" : ref ? "Page" : "Pages";
  return SCREENS[head] ?? "Queue";
}

type CameFrom = { at: string; opener?: string | null };

let kept: CameFrom | null = null;

function cameFrom(): CameFrom | null {
  const state = history.state as Partial<CameFrom> | null;
  return typeof state?.at === "string" && !state.at.startsWith("/settings") ? { at: state.at, opener: state.opener } : kept;
}

function Group({ title, aside, note, className, children }: { title: string; aside?: ReactNode; note?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between gap-3 px-1 pb-2">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      <div className="settings-rows overflow-hidden rounded-card border border-line bg-panel">{children}</div>
      {note && <p className="px-1 pt-2 text-small text-ink-2">{note}</p>}
    </section>
  );
}

function RowLink({ to, label, value, accent }: { to: string; label: string; value?: ReactNode; accent?: boolean }) {
  return (
    <Link to={to} className="settings-row flex items-center gap-3 px-4 text-body hover:bg-hover">
      <span className="min-w-0 flex-1">{label}</span>
      {value !== undefined && <span className={cx("text-meta", accent ? "settings-badge rounded-full px-2.5 py-0.5 font-semibold text-ink" : "text-ink-2")}>{value}</span>}
      <Icon name="chevR" size="sm" className="text-ink-3" />
    </Link>
  );
}

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle} className="settings-switch inline-flex h-11 flex-none cursor-pointer items-center justify-end" data-testid="switch">
      <span className={cx("settings-track flex items-center rounded-full border", on ? "border-transparent bg-brass" : "border-line-3 bg-control")}>
        <span className={cx("settings-knob size-6 rounded-full", on && "is-on")} />
      </span>
    </button>
  );
}

function Segmented<T extends string>({ label, items, value, onPick, testId }: { label: string; items: { id: T; text: string }[]; value: T; onPick: (id: T) => void; testId?: string }) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="settings-choices grid gap-1 rounded-control border border-line-3 bg-well" style={{ gridTemplateColumns: "repeat(" + items.length + ", minmax(0, 1fr))" }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          onClick={() => onPick(item.id)}
          className={cx("min-h-11 cursor-pointer rounded-small border text-meta font-semibold", value === item.id ? "border-line-3 bg-raised text-ink" : "border-transparent text-ink-2 hover:text-ink")}
        >
          {item.text}
        </button>
      ))}
    </div>
  );
}

function useBots() {
  const { world } = useWorld();
  const admin = useBotsAdmin();
  const all = world?.bots ?? [];
  const gone = (bot: Bot) => Boolean(bot.removedAt) || Boolean(admin?.removed[bot.id]);
  const listed = new Set(all.map((bot) => bot.id));
  const extra: Bot[] = (admin?.joined ?? []).filter((bot) => !listed.has(bot.id)).map((bot, at) => ({ id: bot.id, name: bot.name, role: bot.role, color: "var(--color-avatar-1)", pinned: false, order: 90 + at }));
  const bots = [...extra, ...all.filter((bot) => !gone(bot))];
  const removed = all.filter(gone);
  return { ready: world !== null, bots, removed, admin };
}

function NoBots() {
  return <p className="text-body text-ink-2">Approve new bots in Backchannel for now.</p>;
}

function useNow(ticking: boolean): number {
  const { now } = useQd();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now();
}

function PendingCard({ join, api, admin, now }: { join: PendingJoin; api: BotsApi; admin: BotsAdmin; now: number }) {
  const [typed, setTyped] = useState("");
  const needsPassword = admin.password;
  return (
    <div className="grid gap-3 px-4 py-3.5" data-testid="pending-join">
      <div className="flex items-start gap-3">
        <Avatar name={join.name} color="var(--color-avatar-3)" size="lg" />
        <div className="min-w-0 flex-1">
          <b className="block text-body font-semibold">{join.name} wants to join</b>
          <span className="block text-small text-ink-2">
            invited by {join.invitedBy} · {join.at}
          </span>
          <span className="mt-0.5 block text-small text-ink-2">
            Code <code className="rounded-md bg-raised px-1.5 py-px font-mono text-xs text-ink">{join.code}</code>
            {join.endsAt && " · " + endsText(join.endsAt, now)}
          </span>
        </div>
      </div>
      {admin.approveHere ? (
        <>
          {needsPassword && <PasswordField value={typed} onText={setTyped} />}
          <div className="grid grid-cols-2 gap-3">
            <Button kind="plain" className="min-h-11 py-0" onClick={() => void api.refuseJoin(join.id)} data-testid="pending-refuse">
              Refuse
            </Button>
            <Button kind="primary" className="min-h-11 py-0" disabled={needsPassword && typed.length === 0} onClick={() => api.approveJoin(join.id)} data-testid="pending-approve">
              Approve
            </Button>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-2 items-center gap-3">
          <Button kind="plain" className="min-h-11 py-0" disabled={admin.busy} onClick={() => void api.refuseJoin(join.id)} data-testid="pending-refuse">
            Refuse
          </Button>
          <p className="text-small text-ink-2">{BOTS_WORDS.approve}</p>
        </div>
      )}
    </div>
  );
}

function BotRow({ bot, note }: { bot: Bot; note: BotNote | undefined }) {
  return (
    <Link to={href.settings("bots", bot.id)} className="settings-row-lg flex items-center gap-3 px-4 py-2.5 hover:bg-hover" data-testid="bot-row" data-id={bot.id}>
      <Avatar name={bot.name} color={bot.color} size="lg" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <b className="min-w-0 truncate text-body font-semibold" data-truncates="">
            {bot.name}
            {bot.role && <span className="font-normal text-ink-2"> · {bot.role}</span>}
          </b>
          <span className="ml-auto flex-none text-small text-ink-2">{note?.active}</span>
        </span>
        {note && (
          <span className="block truncate text-small text-ink-3">
            joined {note.joined} · invited by {note.invitedBy}
          </span>
        )}
      </span>
      <Icon name="chevR" size="sm" className="text-ink-3" />
    </Link>
  );
}

function HistoryRows({ startOpen, history }: { startOpen: boolean; history: HistoryLine[] }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen((on) => !on)} className="settings-row flex w-full cursor-pointer items-center gap-3 px-4 text-left text-body hover:bg-hover" data-testid="history-toggle">
        <span className="min-w-0 flex-1">Joins history</span>
        <Icon name={open ? "chevD" : "chevR"} size="sm" className="text-ink-3" />
      </button>
      {open &&
        history.map((line) => (
          <p key={line.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-small text-ink-2">
            <span className="min-w-0">{line.text}</span>
            <time className="flex-none text-ink-3">{line.at}</time>
          </p>
        ))}
    </>
  );
}

const addsHere = (admin: BotsAdmin) => __QD_SOURCE__ === "server" || !admin.approveHere;

function BotsBody({ wide }: { wide: boolean }) {
  const { ready, bots, removed, admin } = useBots();
  const api = useBotsApi();
  const now = useNow(Boolean(admin?.pending.some((join) => join.endsAt) || admin?.invites.some((invite) => invite.endsAt)));
  const frame = useFrame();
  const addButton = useRef<HTMLButtonElement>(null);
  if (!ready) return <LoadingBars rows={4} height={64} />;
  if (!admin || !api || admin.state === "approval") return <NoBots />;
  if (admin.state === "loading") return <LoadingBars rows={4} height={64} />;
  if (admin.state === "failed")
    return (
      <ErrorLine onRetry={() => void api.reload()} retryLabel="Try again">
        {BOTS_WORDS.list}
      </ErrorLine>
    );
  const notice = admin.notice && (
    <ErrorLine key="notice" onRetry={admin.notice.again ? () => void api.again() : undefined} retryLabel="Try again">
      {admin.notice.words}
    </ErrorLine>
  );
  const pending = (
    <Group title="Pending joins" aside={<span className="text-small text-ink-2">{admin.pending.length}</span>} key="pending">
      {admin.pending.length ? admin.pending.map((join) => <PendingCard key={join.id + (admin.password ? "+" : "")} join={join} api={api} admin={admin} now={now} />) : <p className="px-4 py-4 text-meta text-ink-2">No joins waiting.</p>}
    </Group>
  );
  const invites = (
    <Group title="Open invites" aside={<span className="text-small text-ink-2">{admin.invites.length}</span>} note="The invite text is never shown again." key="invites">
      {admin.invites.length ? (
        admin.invites.map((invite) => (
          <div key={invite.id} className="settings-row-md flex items-center gap-3 px-4 py-2" data-testid="open-invite">
            <span className="min-w-0 flex-1">
              <b className="block truncate text-body font-semibold">for {invite.forName ?? "any bot"}</b>
              <span className="block text-small text-ink-2">
                by {invite.by} · {invite.endsAt ? endsText(invite.endsAt, now) : invite.ends}
              </span>
            </span>
            <Button kind="ghost" className="min-h-11 px-4 py-0 text-meta" disabled={admin.busy} onClick={() => void api.cancelInvite(invite.id)}>
              Cancel
            </Button>
          </div>
        ))
      ) : (
        <p className="px-4 py-4 text-meta text-ink-2">No open invites.</p>
      )}
      {addsHere(admin) && (
        <button ref={addButton} type="button" disabled={admin.busy} onClick={() => frame?.openAddBot(addButton)} className="settings-row flex w-full cursor-pointer items-center gap-3 px-4 text-left text-body font-semibold hover:bg-hover disabled:cursor-default disabled:text-ink-3" data-testid="bots-add">
          <Icon name="plus" size="sm" className="text-ink-2" />
          Add bot
        </button>
      )}
    </Group>
  );
  const rules = admin.approveHere ? (
    <Group title="Joins" key="rules">
      <HistoryRows startOpen={wide} history={admin.history} />
      <div className="settings-row-md flex items-center gap-3 px-4">
        <span className="min-w-0 flex-1">
          <b className="block text-body font-semibold">Password to approve a bot</b>
          <span className="block text-small text-ink-2">{admin.password ? "On" : "Off"}</span>
        </span>
        <Switch on={admin.password} label="Password to approve a bot" onToggle={() => api.setPassword(!admin.password)} />
      </div>
    </Group>
  ) : (
    <Group title="Joins" key="rules">
      <p className="px-4 py-4 text-meta text-ink-2">{BOTS_WORDS.history}</p>
    </Group>
  );
  const list = (
    <Group title="All bots" aside={<span className="text-small text-ink-2">{bots.length}</span>} key="bots">
      {bots.length ? bots.map((bot) => <BotRow key={bot.id} bot={bot} note={admin.notes[bot.id]} />) : <p className="px-4 py-4 text-meta text-ink-2">No bots yet. Add bot to bring one in.</p>}
    </Group>
  );
  const gone = removed.length ? (
    <Group title="Removed" key="removed">
      {removed.map((bot) => (
        <div key={bot.id} className="settings-row-lg flex items-center gap-3 px-4 py-2.5" data-testid="removed-bot">
          <Avatar name={bot.name} color="var(--color-ink-3)" size="lg" />
          <span className="min-w-0 flex-1">
            <b className="block truncate text-body font-semibold text-ink-2">
              {bot.name}
              <span className="font-normal"> · {bot.role}</span>
            </b>
            <span className="block text-small text-ink-2">
              removed {admin.removed[bot.id] ?? admin.notes[bot.id]?.active.replace("removed ", "") ?? "Today"} · mail kept, read only
            </span>
          </span>
        </div>
      ))}
    </Group>
  ) : null;
  if (wide) {
    const columns = (
      <div className="grid grid-cols-2 items-start gap-6">
        <div className="grid grid-cols-1 gap-6">
          {pending}
          {invites}
          {rules}
        </div>
        <div className="grid grid-cols-1 gap-6">
          {list}
          {gone}
        </div>
      </div>
    );
    return notice ? (
      <div className="grid gap-6">
        {notice}
        {columns}
      </div>
    ) : (
      columns
    );
  }
  return (
    <div className="grid gap-6">
      {notice}
      {pending}
      {list}
      {gone}
      {invites}
      {rules}
    </div>
  );
}

function BotBody({ botId }: { botId: string }) {
  const { ready, bots, removed, admin } = useBots();
  const api = useBotsApi();
  const [confirming, setConfirming] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  if (!ready) return <LoadingBars rows={3} height={64} />;
  if (!admin || !api || admin.state === "approval") return <NoBots />;
  if (admin.state === "loading") return <LoadingBars rows={3} height={64} />;
  if (admin.state === "failed")
    return (
      <ErrorLine onRetry={() => void api.reload()} retryLabel="Try again">
        {BOTS_WORDS.list}
      </ErrorLine>
    );
  const bot = bots.find((item) => item.id === botId) ?? removed.find((item) => item.id === botId);
  if (!bot) return <p className="text-body text-ink-2">This bot is not in your list.</p>;
  const gone = removed.some((item) => item.id === botId);
  const note = admin.notes[bot.id];
  const pinned = admin.pinned[bot.id] ?? bot.pinned;
  return (
    <div className="settings-split grid gap-6 wide:items-start">
      <div className="settings-span flex items-center gap-4 rounded-card border border-line bg-panel px-4 py-4">
        <Avatar name={bot.name} color={bot.color} size="xl" />
        <div className="min-w-0 flex-1">
          <b className="block text-row font-semibold">
            {bot.name}
            {bot.role ? " · " + bot.role : ""}
          </b>
          {note && (
            <span className="block text-small text-ink-2">
              Joined {note.joined} · invited by {note.invitedBy}
            </span>
          )}
          {(gone || note) && <span className="block text-small text-ink-2">{gone ? "Removed, mail kept, read only" : "Last active " + (note?.active.replace("active ", "") ?? "")}</span>}
        </div>
        {!gone && (
          <Button kind="plain" className="min-h-11 px-4 py-0" onClick={() => api.setPinned(bot.id, !pinned)} aria-pressed={pinned} data-testid="bot-pin">
            {pinned ? "Unpin" : "Pin"}
          </Button>
        )}
      </div>
      <Group title="Bot">
        <div className="settings-row flex items-center gap-3 px-4 text-body">
          <span className="flex-1">Role</span>
          <span className="text-meta text-ink-2">{bot.role}</span>
        </div>
        <div className="settings-row flex items-center gap-3 px-4 text-body">
          <span className="flex-1">Secrets</span>
          <span className="text-meta text-ink-2">2</span>
        </div>
        <RowLink to={href.mail()} label="Mail" value="MT threads" />
      </Group>
      {!gone && __QD_SOURCE__ !== "server" && (
        <Group title="Remove" note="Only you can do this. Its mail is kept.">
          <button ref={removeButton} type="button" onClick={() => setConfirming(true)} className="settings-row flex w-full cursor-pointer items-center gap-3 px-4 text-left text-body font-semibold text-red hover:bg-hover" data-testid="remove-bot">
            Remove bot...
          </button>
        </Group>
      )}
      {confirming && (
        <RemoveBotDialog
          name={bot.name}
          onCancel={() => {
            setConfirming(false);
            removeButton.current?.focus({ preventScroll: true });
          }}
          onConfirm={() => {
            api.removeBot(bot.id, bot.name);
            setConfirming(false);
            go(href.settings("bots"));
          }}
        />
      )}
    </div>
  );
}

function AppearanceBody({ onPick }: { onPick: (appearance: Appearance) => void }) {
  const settings = useSettings();
  return (
    <Group title="Appearance" note="Applies at once.">
      <div role="radiogroup" aria-label="Appearance" className="settings-choices grid" data-testid="settings-appearance">
        <ChoiceRow on={settings.appearance === "system"} label="System" detail="follows your device" onClick={() => onPick("system")} className="min-h-14" />
        <ChoiceRow on={settings.appearance === "light"} label="Light" onClick={() => onPick("light")} className="min-h-14" />
        <ChoiceRow on={settings.appearance === "dark"} label="Dark" onClick={() => onPick("dark")} className="min-h-14" />
      </div>
    </Group>
  );
}

function AddonsBody() {
  return (
    <Group title="Pages">
      <div className="settings-row-lg flex items-center gap-3 px-4">
        <span className="min-w-0 flex-1">
          <b className="block text-body font-semibold">Pages</b>
          <span className="block text-small text-ink-2">Bots publish Pages; you choose which become public.</span>
        </span>
        <span className="rounded-full bg-green-soft px-2.5 py-0.5 text-meta font-semibold text-green">On</span>
      </div>
    </Group>
  );
}

function Cleanup({ cleanup, api }: { cleanup: { on: boolean; days: CleanupDays }; api: BotsApi }) {
  const [asking, setAsking] = useState(false);
  const days = cleanup.days;
  return (
    <>
      <Group title="Cleanup" note="Never removes Artifacts, or files a Task Card or Page uses.">
        <div className="settings-row-lg flex items-center gap-3 px-4 py-2">
          <span className="min-w-0 flex-1 text-body font-semibold">Remove files nobody opened for {days} days</span>
          <span className="flex-none text-meta text-ink-2">{cleanup.on ? "On" : "Off"}</span>
          <Switch on={cleanup.on} label={"Remove files nobody opened for " + days + " days"} onToggle={() => (cleanup.on ? api.setCleanup({ ...cleanup, on: false }) : setAsking(true))} />
        </div>
        <div className="p-3">
          <Segmented<`${CleanupDays}`>
            label="Days before removal"
            testId="cleanup-days"
            items={[
              { id: "30", text: "30 days" },
              { id: "60", text: "60 days" },
              { id: "90", text: "90 days" },
            ]}
            value={`${days}`}
            onPick={(id) => api.setCleanup({ ...cleanup, days: Number(id) as CleanupDays })}
          />
        </div>
      </Group>
      {asking && (
        <CleanupDialog
          days={days}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            api.setCleanup({ ...cleanup, on: true });
            setAsking(false);
          }}
        />
      )}
    </>
  );
}

function StorageBody() {
  const admin = useBotsAdmin();
  const api = useBotsApi();
  return (
    <div className="settings-split grid gap-6 wide:items-start">
      <Group title="Files" note="(first 10 GB free, then 0.015 USD a GB)">
        <div className="settings-files grid gap-3 px-4">
          <div className="flex items-center gap-3 text-body">
            <span className="flex-1">Files in chats and mail</span>
            <b className="font-semibold" data-testid="storage-size">
              3.2 GB
            </b>
          </div>
          <span role="img" aria-label="3.2 of the 10 GB that are free" className="settings-bar block overflow-hidden rounded-full bg-raised">
            <span className="block rounded-full bg-brass" />
          </span>
        </div>
        <div className="settings-row flex items-center gap-3 px-4 text-body">
          <span className="flex-1">This month, about</span>
          <b className="font-semibold">0.00 USD</b>
        </div>
      </Group>
      {admin && api && <Cleanup cleanup={admin.cleanup} api={api} />}
    </div>
  );
}

function AccountBody({ onSignedOut }: { onSignedOut: () => void }) {
  const settings = useSettings();
  const [confirming, setConfirming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="grid gap-6">
      <Group title="Account" note="This device only.">
        <div className="settings-row flex items-center gap-3 px-4 text-body">
          <span className="flex-1">Email</span>
          <span className="min-w-0 text-meta [overflow-wrap:anywhere] text-ink-2">{settings.email}</span>
        </div>
        <button ref={button} type="button" onClick={() => setConfirming(true)} className="settings-row flex w-full cursor-pointer items-center gap-3 px-4 text-left text-body font-semibold text-red hover:bg-hover" data-testid="sign-out">
          Sign out
        </button>
      </Group>
      {confirming && <SignOutConfirm onClose={() => setConfirming(false)} onSignedOut={onSignedOut} returnTo={button} />}
    </div>
  );
}

function Overview({ wide, onPick, onSignedOut }: { wide: boolean; onPick: (appearance: Appearance) => void; onSignedOut: () => void }) {
  const admin = useBotsAdmin();
  const settings = useSettings();
  const { ready, bots } = useBots();
  const count = ready ? bots.length : "-";
  const [signing, setSigning] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const bot = (
    <Group title="Bots" key="bots">
      <RowLink to={href.settings("bots")} label="All bots" value={count} />
      <RowLink to={href.settings("bots")} label="Pending joins" value={admin?.pending.length} accent={Boolean(admin?.pending.length)} />
      <RowLink to={href.settings("bots")} label="Open invites" value={admin?.invites.length} />
      <RowLink to={href.settings("bots")} label="Joins history" />
      <RowLink to={href.settings("bots")} label="Password to approve a bot" value={admin ? (admin.password ? "On" : "Off") : undefined} />
    </Group>
  );
  const look = wide ? (
    <AppearanceBody onPick={onPick} key="look" />
  ) : (
    <Group title="Appearance" note="System follows your device." key="look">
      <div className="p-2.5">
        <Segmented<Appearance>
          label="Appearance"
          testId="settings-appearance-quick"
          items={[
            { id: "system", text: "System" },
            { id: "light", text: "Light" },
            { id: "dark", text: "Dark" },
          ]}
          value={settings.appearance}
          onPick={onPick}
        />
      </div>
    </Group>
  );
  const addons = (
    <Group title="Add-ons" key="addons">
      <RowLink to={href.settings("add-ons")} label="Pages" value="On" />
    </Group>
  );
  const storage = (
    <Group title="Storage" key="storage">
      <RowLink to={href.settings("storage")} label="Files and cleanup" value="3.2 GB" />
    </Group>
  );
  const account = (
    <Group title="Account" key="account">
      <div className="settings-row flex items-center gap-3 px-4 text-body">
        <span className="flex-1">Email</span>
        <span className="min-w-0 text-meta [overflow-wrap:anywhere] text-ink-2">{settings.email}</span>
      </div>
      <button ref={button} type="button" onClick={() => setSigning(true)} className="settings-row flex w-full cursor-pointer items-center gap-3 px-4 text-left text-body font-semibold text-red hover:bg-hover" data-testid="sign-out">
        Sign out
      </button>
    </Group>
  );
  return (
    <>
      {wide ? (
        <div className="settings-columns grid grid-cols-2 items-start">
          <div className="settings-columns grid">
            {bot}
            {addons}
          </div>
          <div className="settings-columns grid">
            {look}
            {storage}
            {account}
          </div>
        </div>
      ) : (
        <div className="grid gap-5">
          {bot}
          {look}
          {addons}
          {storage}
          {account}
        </div>
      )}
      {signing && <SignOutConfirm onClose={() => setSigning(false)} onSignedOut={onSignedOut} returnTo={button} />}
    </>
  );
}

function Body({ section, botId, wide, onPick, onSignedOut }: { section: SettingsSection | null; botId: string | null; wide: boolean; onPick: (appearance: Appearance) => void; onSignedOut: () => void }) {
  if (!section) return <Overview wide={wide} onPick={onPick} onSignedOut={onSignedOut} />;
  if (section === "bots") return botId ? <BotBody botId={botId} /> : <BotsBody wide={wide} />;
  if (section === "appearance") return <AppearanceBody onPick={onPick} />;
  if (section === "add-ons") return <AddonsBody />;
  if (section === "storage") return <StorageBody />;
  return <AccountBody onSignedOut={onSignedOut} />;
}

function SectionList({ section }: { section: SettingsSection | null }) {
  const admin = useBotsAdmin();
  return (
    <nav aria-label="Settings sections" className="grid gap-0.5" data-testid="settings-sections">
      {SECTIONS.map((name) => (
        <Link
          key={name}
          to={href.settings(name)}
          aria-current={section === name ? "page" : undefined}
          className={cx("flex min-h-11 items-center gap-2 rounded-[11px] px-3 text-body font-medium", section === name ? "bg-raised text-ink" : "text-ink-2 hover:bg-control hover:text-ink")}
        >
          <span className="flex-1">{TITLES[name]}</span>
          {name === "bots" && admin && admin.pending.length > 0 && <span className="settings-badge rounded-full px-2 py-px text-tag font-semibold text-ink">{admin.pending.length}</span>}
        </Link>
      ))}
    </nav>
  );
}

function backFor(section: SettingsSection | null, botId: string | null, out: string): { to: string; name: string; leaves: boolean } {
  if (!section) return { to: out, name: screenName(out), leaves: true };
  if (section === "bots" && botId) return { to: href.settings("bots"), name: "Bots", leaves: false };
  return { to: href.settings(), name: "Settings", leaves: false };
}

function PhoneTop({ to, name, onBack }: { to: string; name: string; onBack?: () => void }) {
  const frame = useFrame();
  const search = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <FloatTop>
        <FloatBack to={to} label={"Back to " + name} onClick={onBack} />
        {frame && (
          <FloatCapsule label="Settings actions">
            <FloatAction ref={search} glyph="search" label="Search" onClick={() => frame.openSearch(search)} data-testid="float-search" />
            {__QD_SOURCE__ !== "server" && <FloatAction ref={more} glyph="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="float-more" />}
          </FloatCapsule>
        )}
      </FloatTop>
      {open && frame && <MoreSheet items={[{ icon: "plus", label: "Add bot", onPick: frame.openAddBot }]} from={more} onClose={() => setOpen(false)} />}
    </>
  );
}

export function SettingsScreen({ section: asked, botId: askedBot, wide, onSignedOut }: { section?: string; botId?: string; wide: boolean; onSignedOut: () => void }) {
  const section = SECTIONS.find((name) => name === asked) ?? null;
  const botId = (section === "bots" && askedBot) || null;
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef(0);
  const settings = useSettings();
  const { bots, removed } = useBots();
  const phone = usePhone();
  const from = cameFrom();
  useEffect(() => {
    kept = from;
    if (from && (history.state as Partial<CameFrom> | null)?.at !== from.at) history.replaceState({ ...history.state, ...from }, "");
  });
  const out = from?.at ?? href.queue();
  const leave = () => go(out, { focus: from?.opener ?? "settings-btn" });
  useEffect(
    () => () => {
      kept = null;
    },
    [],
  );
  useKeys(true, (event) => {
    if (event.key !== "Escape") return;
    leave();
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = (text: string) => {
    window.clearTimeout(timer.current);
    setToast(text);
    timer.current = window.setTimeout(() => setToast(null), 2400);
  };
  const pick = (appearance: Appearance) => {
    saveSettings({ ...settings, appearance });
    say("Appearance: " + APPEARANCE[appearance]);
  };
  const botName = botId ? ([...bots, ...removed].find((bot) => bot.id === botId)?.name ?? "Bot") : null;
  const title = section ? (botName ?? TITLES[section]) : "Settings · Captain";
  const narrow = section === "appearance" || section === "add-ons" || section === "account";
  const toastNode = toast && (
    <p role="status" className="settings-toast pointer-events-none fixed inset-x-4 z-40 mx-auto w-fit max-w-[calc(100%-32px)] rounded-full border border-line-3 bg-raised px-4 py-2.5 text-meta text-ink" data-testid="toast">
      {toast}
    </p>
  );

  if (wide)
    return (
      <div className="settings-mac grid flex-1" data-testid="settings-screen">
        <link rel="stylesheet" href="/settings.css" precedence="settings" />
        <div className="sticky top-0 h-dvh border-r border-line px-3 pb-6">
          <Head className="px-1">
            <h1 className="min-w-0 text-title font-bold tracking-[-.01em]">Settings · Captain</h1>
          </Head>
          <div className="pt-3">
            <SectionList section={section} />
          </div>
        </div>
        <div className="settings-main min-w-0 pb-16">
          <div className="settings-page mx-auto">
            {section && (
              <h2 className="settings-title font-bold tracking-[-.02em]">
                {botId && (
                  <Link to={href.settings("bots")} className="settings-crumb text-ink-3 hover:text-ink">
                    Bots /
                  </Link>
                )}
                {title}
              </h2>
            )}
            {!section && <p className="settings-lead text-meta text-ink-2">Bots, appearance, add-ons, storage and your account.</p>}
            <div className={narrow ? "settings-narrow" : undefined}>
              <Body section={section} botId={botId} wide onPick={pick} onSignedOut={onSignedOut} />
            </div>
          </div>
        </div>
        {toastNode}
      </div>
    );

  const back = backFor(section, botId, out);
  return (
    <div className={cx("flex min-h-dvh flex-col", phone && FLOAT_TOP_PAD)} data-testid="settings-screen">
      <link rel="stylesheet" href="/settings.css" precedence="settings" />
      {phone ? (
        <PhoneTop to={back.to} name={back.name} onBack={back.leaves ? leave : undefined} />
      ) : (
        <Head className="px-2">
          <BackLink to={back.to} onClick={back.leaves ? leave : undefined}>
            {back.name}
          </BackLink>
        </Head>
      )}
      <div className="settings-phone grid gap-5 px-4 pt-2">
        <h1 className="text-screen font-bold tracking-[-.02em]">{title}</h1>
        <Body section={section} botId={botId} wide={false} onPick={pick} onSignedOut={onSignedOut} />
      </div>
      {toastNode}
    </div>
  );
}
