import { useRef, useState, type ReactNode } from "react";
import { openOutside } from "../platform/open-link";
import { Button } from "./button";
import { cx } from "./cx";
import { Dialog, DialogHead } from "./overlay";

type Request = { url: string; origin: string; botName: string };

export type RequestBotLink = (url: string, opener: HTMLButtonElement) => void;

type Props = { url: string; confirm: RequestBotLink; children: ReactNode; className?: string; testId?: string };

export function BotLink({ url, confirm, children, className, testId = "bot-link" }: Props) {
  return (
    <button type="button" aria-haspopup="dialog" className={cx("cursor-pointer text-left", className)} data-testid={testId} onClick={(event) => confirm(url, event.currentTarget)}>
      {children}
    </button>
  );
}

export function BotLinkConfirmation({ botName, children }: { botName: string; children: (confirm: RequestBotLink) => ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => setRequest(null);
  const confirm: RequestBotLink = (url, from) => {
    const address = new URL(url);
    opener.current = from;
    setRequest({ url: address.href, origin: address.origin, botName });
  };
  const title = request ? "Open a link from " + request.botName + "?" : "";
  return (
    <>
      {children(confirm)}
      {request && (
        <Dialog label={title} pop="bot-link-confirm" onClose={close} returnTo={opener} compact>
          <DialogHead title={title} onClose={close} />
          <div className="grid min-h-0 gap-3 overflow-y-auto px-4 py-4">
            <p className="font-mono text-body break-all" data-testid="bot-link-origin">{request.origin}</p>
            <p className="text-body text-ink-2">{request.botName} supplied this address. Quarterdeck has not checked where it leads.</p>
          </div>
          <div className="grid flex-none grid-cols-2 gap-2 border-t border-line p-3">
            <Button kind="primary" onClick={() => {
              openOutside(request.url);
              close();
            }}>Open</Button>
            <Button kind="ghost" onClick={close} data-autofocus="">Cancel</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
