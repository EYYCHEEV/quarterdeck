import type { ReactNode, RefObject } from "react";
import type { Loaded } from "../data/chat-hooks";
import type { ChatRow } from "../data/chat-types";
import { useJoinedBots } from "../data/bots-hooks";
import { useQd, useWorld } from "../data/hooks";
import { avatarColor } from "../domain/avatar";
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
      className={cx("flex min-h-hit items-center gap-s3 rounded-key px-s2 text-body font-strong", on ? "bg-raised text-ink" : "text-ink-2 hover:bg-control hover:text-ink")}
    >
      <Icon name={icon} />
      <span className="flex flex-1 items-center gap-s2">
        {label}
        {dot && <NewDot />}
      </span>
      {count}
    </Link>
  );
}

function UnreadDot({ className }: { className?: string }) {
  return <span role="img" aria-label="Unread" className={cx("size-mark-new flex-none bg-new", className)} />;
}

function Pinned({ rows, current }: { rows: ChatRow[]; current: string | null }) {
  return (
    <div className={cx("flex gap-s1 px-s1 pt-s1 pb-s1", current && "chat-whole")}>
      {rows.map((row) => (
        <Link
          key={row.bot.id}
          to={href.chat(row.bot.id)}
          data-testid="pinned-bot"
          data-id={row.bot.id}
          aria-current={current === row.bot.id ? "page" : undefined}
          aria-label={row.bot.name + (row.unread && current !== row.bot.id ? ", unread" : "")}
          className={cx(
            "relative flex w-[78px] flex-col items-center gap-s1 rounded-key px-s1 py-s2 text-center text-label font-strong",
            current === row.bot.id ? "bg-control text-ink" : "text-ink-2 hover:bg-control hover:text-ink",
          )}
        >
          <Avatar name={row.bot.name} color={row.bot.color} size="xl" />
          {row.bot.name}
          {row.unread && current !== row.bot.id && <UnreadDot className="absolute top-s2 right-s4 size-s3 border-2 border-side" />}
        </Link>
      ))}
    </div>
  );
}

function Chats({ rows, current, now }: { rows: ChatRow[]; current: string | null; now: number }) {
  const listed = useShown(rows, (row) => row.bot.id, "");
  return (
    <ul className="grid min-w-0 grid-cols-1 gap-hair" data-truncates="" data-testid="chats">
      {listed.shown.map((entry) => {
        const row = entry.item;
        return (
          <li key={entry.id} className={current ? "chat-whole" : undefined} {...rowMotion(entry, listed.drop)}>
            <Link
              to={href.chat(row.bot.id)}
              data-testid="chat-row"
              data-id={row.bot.id}
              aria-current={current === row.bot.id ? "page" : undefined}
              className={cx("flex min-h-[52px] items-start gap-s2 rounded-key px-s2 py-s2", current === row.bot.id ? "bg-control" : "hover:bg-control")}
            >
              {current && <Avatar name={row.bot.name} color={row.bot.color} size="md" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-s2">
                  <span className="inline-flex flex-none items-center rounded-round border border-line px-s1 text-label leading-snug font-strong text-ink-2">Bot</span>
                  <b className={cx("min-w-0 truncate text-body font-strong", current && "flex-1")}>{row.bot.name}</b>
                  {!current && <span className="min-w-0 flex-1 truncate text-label text-ink-2">{row.bot.role}</span>}
                  {__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && !row.at ? null : <time className="flex-none text-label text-ink-2">{listStamp(row.at, now)}</time>}
                </span>
                {current && <span className="block text-label text-ink-2">{row.bot.role}</span>}
                <span className="mt-nudge flex items-start gap-s2 text-meta">
                  <span className={cx("min-w-0 flex-1 truncate", row.unread && current !== row.bot.id ? "text-ink" : "text-ink-2")}>{__QD_SOURCE__ === "server" && __QD_CHAT__ === "on" && !row.at ? "No messages yet." : row.preview}</span>
                  {row.unread && current !== row.bot.id && <UnreadDot className="mt-s1" />}
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
    bot: { id: bot.id, name: bot.name, role: bot.role, color: avatarColor(1), pinned: false, order: -1 - order },
    preview: "Joined just now",
    at: new Date(now()).toISOString(),
    unread: true,
  }));
  return (
    <nav aria-label="Quarterdeck" className={SIDEBAR}>
      <div className="mb-s2 flex items-center gap-s1 pl-s2">
        <span className="flex-1 text-body font-strong">Quarterdeck</span>
        <IconButton ref={searchButton} icon="search" label="Search" title="Search (⌘K)" onClick={onSearch} data-testid="search-btn" />
        {drawer && <IconButton icon="x" label="Close the menu" onClick={onClose} data-testid="pop-close" />}
      </div>
      <div className="grid gap-hair">
        <NavItem
          to={href.queue()}
          icon="queue"
          label="Queue"
          on={route.name === "queue"}
          count={waiting === null ? null : <span className="text-label font-strong text-ink-2">{waiting}</span>}
        />
        <NavItem to={href.projects()} icon="projects" label="Projects" dot={fresh} on={route.name === "projects" || route.name === "lane" || route.name === "pages" || route.name === "page" || route.name === "artifact"} />
        <NavItem to={href.mail()} icon="mail" label="Mail" on={route.name === "mail"} />
      </div>
      {__QD_SOURCE__ !== "server" && (
        <div className="mt-s2 px-s1">
          <button
            ref={addBotButton}
            type="button"
            onClick={onAddBot}
            data-testid="add-bot-btn"
            className="inline-flex min-h-hit cursor-pointer items-center gap-s1 rounded-round border border-line-3 bg-panel px-s3 text-label font-strong text-ink-2 hover:text-ink"
          >
            <Icon name="plus" size="xs" />
            Add bot
          </button>
        </div>
      )}
      {chats.failed && !chats.value ? (
        <ErrorLine className="mt-s3" onRetry={chats.retry}>
          Could not load the chats.
        </ErrorLine>
      ) : chats.value ? (
        <>
          <Pinned rows={rows.filter((row) => row.bot.pinned).sort((a, b) => a.bot.order - b.bot.order)} current={current} />
          {current && <p className="chat-whole eyebrow mt-s4 px-s2 pb-s1">Chats</p>}
          <Chats rows={[...joinedRows, ...rows.filter((row) => !row.bot.pinned)]} current={current} now={now()} />
        </>
      ) : (
        <ChatsLoading />
      )}
      <div className="mt-auto flex items-center gap-s1 border-t border-line pt-s2 text-body text-ink-2">
        <button
          ref={accountButton}
          type="button"
          aria-label="Account: Captain"
          aria-haspopup="dialog"
          aria-expanded={account}
          onClick={onAccount}
          data-testid="account-btn"
          className="flex min-h-hit min-w-0 flex-1 cursor-pointer items-center gap-s2 rounded-key pl-s2 text-left hover:bg-control hover:text-ink"
        >
          <Avatar name="Captain" size="md" />
          <span className="flex-1">Captain</span>
        </button>
        <IconButton icon="settings" label="Settings" onClick={onSettings} data-testid="settings-btn" />
      </div>
    </nav>
  );
}
