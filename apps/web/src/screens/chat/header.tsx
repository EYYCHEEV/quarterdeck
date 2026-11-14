import { useRef, useState, type ReactNode } from "react";
import { useNewActivity } from "../../data/chat-hooks";
import type { Bot } from "../../domain/types";
import { Avatar } from "../../ui/avatar";
import { IconButton } from "../../ui/button";
import { FloatAction, FloatCapsule, FloatToggle, FloatTop } from "../../ui/float";
import { FloatLabel } from "../../ui/float-back";
import { Head, useFrame } from "../../ui/head";
import { MoreSheet } from "../../ui/more-sheet";
import { usePhone } from "../../ui/phone";

export function ChatHeader({ botId, bot, wide, choices }: { botId: string; bot: Bot | null; wide: boolean; choices: ReactNode }) {
  const frame = useFrame();
  const phone = usePhone();
  const dot = useNewActivity(botId);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sheet = open && frame && (
    <MoreSheet
      items={[
        { icon: "search", label: "Search", onPick: frame.openSearch },
        { icon: "settings", label: "Settings", onPick: frame.openSettings },
        ...(__QD_SOURCE__ === "server" ? [] : [{ icon: "plus", label: "Add bot", onPick: frame.openAddBot } as const]),
      ]}
      from={more}
      onClose={() => setOpen(false)}
      menu={wide}
      handle={!wide}
      closeLabel={wide ? undefined : "Close"}
    >
      {choices}
    </MoreSheet>
  );

  if (phone)
    return (
      <>
        <FloatTop>
          <FloatToggle dot={dot} />
          {bot && (
            <FloatLabel>
              <Avatar name={bot.name} color={bot.color} size="lg" />
              <span className="flex min-w-0 flex-col leading-tight">
                <h1 className="truncate text-body font-strong">{bot.name}</h1>
                <small className="truncate text-label text-ink-3">{bot.role}</small>
              </span>
            </FloatLabel>
          )}
          <FloatCapsule label="Chat actions">
            <FloatAction ref={more} glyph="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-testid="float-more" />
          </FloatCapsule>
        </FloatTop>
        {sheet}
      </>
    );

  return (
    <>
      <Head className="sticky top-0 z-10 border-b border-line bg-page px-s2 pb-s2 wide:px-s5">
        {bot && (
          <span className="flex min-w-0 flex-1 items-center gap-s2">
            <Avatar name={bot.name} color={bot.color} size="lg" />
            <span className="flex min-w-0 flex-col leading-tight">
              <h1 className="text-body font-strong">{bot.name}</h1>
              <small className="text-label text-ink-3">{bot.role}</small>
            </span>
          </span>
        )}
        <span className="relative ml-auto flex flex-none">
          <IconButton ref={more} icon="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="chat-more" data-testid="chat-more" />
          {wide && sheet}
        </span>
      </Head>
      {!wide && sheet}
    </>
  );
}
