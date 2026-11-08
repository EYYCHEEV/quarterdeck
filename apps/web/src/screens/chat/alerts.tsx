import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChatRows } from "../../data/chat-hooks";
import { href } from "../../domain/routes";
import type { Bot } from "../../domain/types";
import { canPush } from "../../platform/push";
import { readJson, writeJson } from "../../platform/storage";
import { Avatar } from "../../ui/avatar";
import { IconButton } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";

const SOUND_KEY = "quarterdeck-chat-sound";

export function useSound(): [boolean, () => void] {
  const [sound, setSound] = useState(() => readJson(SOUND_KEY) === true);
  useEffect(() => {
    const enable = (event: PointerEvent) => {
      if (readJson(SOUND_KEY) !== null || (event.target instanceof Element && event.target.closest("[data-sound]"))) return;
      writeJson(SOUND_KEY, true);
      setSound(true);
    };
    window.addEventListener("pointerdown", enable);
    return () => window.removeEventListener("pointerdown", enable);
  }, []);
  const toggle = () => {
    writeJson(SOUND_KEY, !sound);
    setSound(!sound);
  };
  return [sound, toggle];
}

export function AlertChoices({ sound, onSound }: { sound: boolean; onSound: () => void }) {
  const [note, setNote] = useState(false);
  return (
    <div className="chat-alert-preferences">
      <button type="button" role="switch" aria-checked={sound} className="chat-sound" onClick={onSound} data-sound="" data-testid="chat-sound">
        <span className="chat-switch" data-on={sound}>
          <span />
        </span>
        Sound {sound ? "on" : "off"}
      </button>
      {canPush() && (
        <button type="button" className="chat-notifications" onClick={() => setNote(true)} data-testid="chat-notifications">
          Turn on notifications
          <Icon name="chevR" size="sm" />
        </button>
      )}
      {note && (
        <p className="w-full text-small text-ink-2" role="status">
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
      <div className="flex items-center gap-3">
        <Avatar name={from.name} color={from.color} size="lg" />
        <Link to={href.chat(from.id)} className="min-w-0 flex-1 py-2" onClick={onDismiss}>
          <span className="block text-small text-ink-2">Bot chat</span>
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
