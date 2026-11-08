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

export function ChatHeader({ botId, bot, choices }: { botId: string; bot: Bot | null; choices: ReactNode }) {
  const frame = useFrame();
  const phone = usePhone();
  const dot = useNewActivity(botId);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sheet = open && frame && (
    <MoreSheet
      items={[
        { icon: "search", label: "Search", onPick: frame.openSearch },
        ...(__QD_SOURCE__ === "server" ? [] : [{ icon: "plus", label: "Add bot", onPick: frame.openAddBot } as const]),
        { icon: "settings", label: "Settings", onPick: frame.openSettings },
      ]}
      from={more}
      onClose={() => setOpen(false)}
    >
      <div className="px-3 pb-2">{choices}</div>
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
              <span className="flex min-w-0 flex-col leading-[1.2]">
                <h1 className="truncate text-prose font-semibold">{bot.name}</h1>
                <small className="truncate text-tag text-ink-3">{bot.role}</small>
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
      <Head className="sticky top-0 z-10 border-b border-line bg-page px-2 pb-2 wide:px-6">
        {bot && (
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <Avatar name={bot.name} color={bot.color} size="lg" />
            <span className="flex min-w-0 flex-col leading-[1.25]">
              <h1 className="text-row font-semibold">{bot.name}</h1>
              <small className="text-tag text-ink-3">{bot.role}</small>
            </span>
          </span>
        )}
        <IconButton ref={more} icon="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className="chat-more ml-auto" data-testid="chat-more" />
      </Head>
      {sheet}
    </>
  );
}
