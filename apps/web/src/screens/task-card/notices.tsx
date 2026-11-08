import { clockTime } from "../../domain/time";
import type { Closure } from "../../domain/types";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

export function ChangedNotice({ by, at, onShow }: { by: string; at: string; onShow: () => void }) {
  return (
    <div className="sticky z-10 mt-4" style={{ bottom: "0.75rem" }} data-testid="changed-notice">
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border bg-panel py-1.5 pr-1.5 pl-3.5 shadow-pop" style={{ borderColor: "color-mix(in oklab, var(--color-violet) 45%, transparent)" }}>
        <p className="min-w-0 py-1.5 text-prose" style={{ flex: "1 1 15rem" }}>
          {by} changed this card at {clockTime(at)}.
        </p>
        <Button kind="outline" className="min-h-11 py-0" onClick={onShow} data-testid="show-new-version">
          Show the new version
        </Button>
      </div>
    </div>
  );
}

export function ClosedNotice({ closure, onNext }: { closure: Closure; onNext: () => void }) {
  return (
    <section role="status" className="mt-6 rounded-panel border border-line-3 bg-panel px-4 py-4" data-testid="closed-notice">
      <p className="flex items-start gap-2.5 text-body font-semibold">
        <Icon name="lock" size="sm" className="mt-1 flex-none text-ink-2" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {closure.by} closed this card at {clockTime(closure.at)}
          {closure.following ? ', on your instruction in chat: "' + closure.following + '".' : "."}
        </span>
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 pl-[26px]">
        <p className="text-prose text-ink-2">Nothing to answer.</p>
        <Button kind="primary" onClick={onNext} data-testid="next-card">
          Next card
        </Button>
      </div>
    </section>
  );
}
