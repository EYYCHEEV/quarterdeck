import type { ReactNode, RefObject } from "react";
import type { Loaded } from "../data/chat-hooks";
import type { ChatRow } from "../data/chat-types";
import { useJoinedBots } from "../data/bots-hooks";
import { useQd, useWorld } from "../data/hooks";
import { rankQueue } from "../domain/queue";
import { href, type Route } from "../domain/routes";
import { anyNew } from "../domain/seen";
import { listStamp } from "../domain/time";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icon";
import { Link } from "../ui/link";
import { rowMotion, useShown } from "../ui/motion";
import { NewDot } from "../ui/row";
import { ErrorLine } from "../ui/states";
import { ChatsLoading, SIDEBAR } from "./sidebar-frame";

function NavItem({ to, icon, label, on, count, dot }: { to: string; icon: IconName; label: string; on: boolean; count?: ReactNode; dot?: boolean }) {
  return (
    <Link
      to={to}
      aria-current={on ? "page" : undefined}
      aria-label={dot ? label + ", new activity" : undefined}
      className={cx("flex min-h-11 items-center gap-[11px] rounded-[11px] px-2.5 text-body font-medium", on ? "bg-raised text-ink" : "text-ink-2 hover:bg-control hover:text-ink")}
    >
      <Icon name={icon} />
      <span className="flex flex-1 items-center gap-2">
        {label}
        {dot && <NewDot />}
      </span>
      {count}
    </Link>
  );
}

function UnreadDot({ className }: { className?: string }) {
  return <span role="img" aria-label="Unread" className={cx("size-[9px] flex-none rounded-full bg-brass", className)} />;
}

function Pinned({ rows, current }: { rows: ChatRow[]; current: string | null }) {
  return (
    <div className={cx("flex gap-1.5 px-1 pt-1 pb-1.5", current && "chat-whole")}>
      {rows.map((row) => (
        <Link
          key={row.bot.id}
          to={href.chat(row.bot.id)}
          data-testid="pinned-bot"
          data-id={row.bot.id}
          aria-current={current === row.bot.id ? "page" : undefined}
          aria-label={row.bot.name + (row.unread && current !== row.bot.id ? ", unread" : "")}
          className={cx(
            "relative flex w-[78px] flex-col items-center gap-[5px] rounded-control px-1 py-2 text-center text-tag font-semibold",
            current === row.bot.id ? "bg-control text-ink" : "text-ink-2 hover:bg-control hover:text-ink",
          )}
        >
          <Avatar name={row.bot.name} color={row.bot.color} size="xl" />
          {row.bot.name}
          {row.unread && current !== row.bot.id && <UnreadDot className="absolute top-2 right-4 size-3 border-2 border-side" />}
        </Link>
      ))}
    </div>
  );
}

function Chats({ rows, current, now }: { rows: ChatRow[]; current: string | null; now: number }) {
  const listed = useShown(rows, (row) => row.bot.id, "");
  return (
    <ul className="grid min-w-0 grid-cols-1 gap-0.5" data-truncates="" data-testid="chats">
      {listed.shown.map((entry) => {
        const row = entry.item;
        return (
          <li key={entry.id} className={current ? "chat-whole" : undefined} {...rowMotion(entry, listed.drop)}>
            <Link
              to={href.chat(row.bot.id)}
              data-testid="chat-row"
              data-id={row.bot.id}
              aria-current={current === row.bot.id ? "page" : undefined}
              className={cx("flex min-h-[52px] items-start gap-2.5 rounded-small px-2.5 py-2", current === row.bot.id ? "bg-control" : "hover:bg-control")}
            >
              {current && <Avatar name={row.bot.name} color={row.bot.color} size="md" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="inline-flex flex-none items-center rounded-full border border-line-2 px-1.5 text-tag leading-[1.3] font-medium text-ink-3">Bot</span>
                  <b className={cx("min-w-0 truncate text-prose font-semibold", current && "flex-1")}>{row.bot.name}</b>
                  {!current && <span className="min-w-0 flex-1 truncate text-tag text-ink-3">{row.bot.role}</span>}
                  {__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && !row.at ? null : <time className="flex-none text-xs text-ink-3">{listStamp(row.at, now)}</time>}
                </span>
                {current && <span className="block text-tag text-ink-3">{row.bot.role}</span>}
                <span className="mt-px flex items-start gap-2 text-small">
                  <span className={cx("min-w-0 flex-1 truncate", row.unread && current !== row.bot.id ? "text-ink-2" : "text-ink-3")}>{__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && !row.at ? "No messages yet." : row.preview}</span>
                  {row.unread && current !== row.bot.id && <UnreadDot className="mt-[5px]" />}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar({
  route,
  drawer,
  onClose,
  onSearch,
  onSettings,
  onAddBot,
  onAccount,
  account,
  searchButton,
  addBotButton,
  accountButton,
  chats,
}: {
  route: Route;
  drawer: boolean;
  onClose: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onAddBot: () => void;
  onAccount: () => void;
  account: boolean;
  searchButton: RefObject<HTMLButtonElement | null>;
  addBotButton: RefObject<HTMLButtonElement | null>;
  accountButton: RefObject<HTMLButtonElement | null>;
  chats: Loaded<ChatRow[]>;
}) {
  const { world } = useWorld();
  const { now } = useQd();
  const waiting = world ? rankQueue(world.cards, world.tasks, now()).length : null;
  const fresh = world ? anyNew(world.lanes, world.bots) : false;
  const current = route.name === "chat" ? route.botId : null;
  const rows = chats.value ?? [];
  const joinedRows: ChatRow[] = useJoinedBots().map((bot, order) => ({
    bot: { id: bot.id, name: bot.name, role: bot.role, color: "var(--color-avatar-1)", pinned: false, order: -1 - order },
    preview: "Joined just now",
    at: new Date(now()).toISOString(),
    unread: true,
  }));
  return (
    <nav aria-label="Quarterdeck" className={SIDEBAR}>
      <div className="mb-2 flex items-center gap-1.5 pl-2.5">
        <span className="flex-1 text-body font-semibold">Quarterdeck</span>
        <IconButton ref={searchButton} icon="search" label="Search" title="Search (⌘K)" onClick={onSearch} data-testid="search-btn" />
        {drawer && <IconButton icon="x" label="Close the menu" onClick={onClose} data-testid="pop-close" />}
      </div>
      <div className="grid gap-0.5">
        <NavItem
          to={href.queue()}
          icon="queue"
          label="Queue"
          on={route.name === "queue"}
          count={waiting === null ? null : <span className="text-tag font-semibold text-ink-2">{waiting}</span>}
        />
        <NavItem to={href.projects()} icon="projects" label="Projects" dot={fresh} on={route.name === "projects" || route.name === "lane" || route.name === "pages" || route.name === "page" || route.name === "artifact"} />
        <NavItem to={href.mail()} icon="mail" label="Mail" on={route.name === "mail"} />
      </div>
      {__QD_SOURCE__ !== "server" && (
        <div className="mt-2 px-1">
          <button
            ref={addBotButton}
            type="button"
            onClick={onAddBot}
            data-testid="add-bot-btn"
            className="inline-flex min-h-11 cursor-pointer items-center gap-[5px] rounded-full border border-line-3 bg-panel px-3 text-tag font-semibold text-ink-2 hover:text-ink"
          >
            <Icon name="plus" size="xs" />
            Add bot
          </button>
        </div>
      )}
      {chats.failed && !chats.value ? (
        <ErrorLine className="mt-3" onRetry={chats.retry}>
          Could not load the chats.
        </ErrorLine>
      ) : chats.value ? (
        <>
          <Pinned rows={rows.filter((row) => row.bot.pinned).sort((a, b) => a.bot.order - b.bot.order)} current={current} />
          {current && <p className="chat-whole eyebrow mt-4 px-2.5 pb-1.5">Chats</p>}
          <Chats rows={[...joinedRows, ...rows.filter((row) => !row.bot.pinned)]} current={current} now={now()} />
        </>
      ) : (
        <ChatsLoading />
      )}
      <div className="mt-auto flex items-center gap-1 border-t border-line pt-2.5 text-note text-ink-2">
        <button
          ref={accountButton}
          type="button"
          aria-label="Account: Captain"
          aria-haspopup="dialog"
          aria-expanded={account}
          onClick={onAccount}
          data-testid="account-btn"
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-small pl-2.5 text-left hover:bg-control hover:text-ink"
        >
          <Avatar name="Captain" color="var(--color-you)" size="md" />
          <span className="flex-1">Captain</span>
        </button>
        <IconButton icon="settings" label="Settings" onClick={onSettings} data-testid="settings-btn" />
      </div>
    </nav>
  );
}
