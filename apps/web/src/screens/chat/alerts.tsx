import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChatRows } from "../../data/chat-hooks";
import { alertsOn, setAlerts } from "../../data/settings";
import { href } from "../../domain/routes";
import type { Bot } from "../../domain/types";
import { canPush } from "../../platform/push";
import { Avatar } from "../../ui/avatar";
import { IconButton } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { MENU_ROW } from "../../ui/more-sheet";

export function AlertSwitch({ botId }: { botId: string }) {
  const [on, setOn] = useState(() => alertsOn(botId));
  const toggle = () => {
    setAlerts(botId, !on);
    setOn(!on);
  };
  return (
    <button type="button" role="switch" aria-checked={on} className={MENU_ROW} onClick={toggle} data-testid="chat-alerts">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>Alerts for this chat</span>
        <small className="text-label font-regular text-ink-3" aria-hidden="true">
          {on ? "On" : "Off"}
        </small>
      </span>
      <span className="chat-switch" data-on={on}>
        <span />
      </span>
    </button>
  );
}

export function NotificationChoice() {
  const [note, setNote] = useState(false);
  if (!canPush()) return null;
  return (
    <div className="chat-alert-preferences">
      <button type="button" className="chat-notifications" onClick={() => setNote(true)} data-testid="chat-notifications">
        Turn on notifications
        <Icon name="chevR" size="sm" />
      </button>
      {note && (
        <p className="w-full text-meta text-ink-2" role="status">
          Notifications will be available when connected to Quarterdeck.
        </p>
      )}
    </div>
  );
}

type Seen = { at: string; unread: boolean; preview: string };

export function useArrival(bot: Bot | null): [Bot | null, () => void] {
  const chats = useChatRows();
  const previous = useRef<Map<string, Seen> | null>(null);
  const [notice, setNotice] = useState<Bot | null>(null);
  const openId = bot?.id;

  useEffect(() => {
    setNotice((shown) => (shown?.id === openId ? null : shown));
  }, [openId]);

  useEffect(() => {
    if (!chats.value) return;
    if (previous.current) {
      const fresh = chats.value.find((row) => {
        const before = previous.current?.get(row.bot.id);
        return row.unread && row.bot.id !== openId && before && (!before.unread || before.at !== row.at || before.preview !== row.preview);
      });
      if (fresh) setNotice(fresh.bot);
    }
    previous.current = new Map(chats.value.map((row) => [row.bot.id, { at: row.at, unread: row.unread, preview: row.preview }]));
  }, [chats.value, openId]);

  useEffect(() => {
    if (!notice) return;
    document.title = "● New message from " + notice.name + " · Quarterdeck";
    return () => {
      document.title = bot ? bot.name + " · Quarterdeck" : "Quarterdeck";
    };
  }, [notice, bot]);

  return [notice, () => setNotice(null)];
}

export function Arrival({ from, onDismiss, children }: { from: Bot; onDismiss: () => void; children: ReactNode }) {
  return (
    <section className="chat-arrival" aria-label="New message" data-testid="chat-new-message">
      <div className="flex items-center gap-s3">
        <Avatar name={from.name} color={from.color} size="lg" />
        <Link to={href.chat(from.id)} className="min-w-0 flex-1 py-s2" onClick={onDismiss}>
          <span className="block text-meta text-ink-2">Bot chat</span>
          <strong className="text-body" role="status">
            New message from {from.name}
          </strong>
        </Link>
        <IconButton icon="x" label="Dismiss new message" onClick={onDismiss} />
      </div>
      {children}
    </section>
  );
}
