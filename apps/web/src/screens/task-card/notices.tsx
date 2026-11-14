import { clockTime } from "../../domain/time";
import type { Closure } from "../../domain/types";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

export function ChangedNotice({ by, at, onShow }: { by: string; at: string; onShow: () => void }) {
  return (
    <div className="sticky bottom-s3 z-10 mt-s4" data-testid="changed-notice">
      <div role="status" className="flex flex-wrap items-center gap-x-s3 gap-y-s1 rounded-panel border border-new bg-panel py-s1 pr-s1 pl-s3 shadow-lift">
        <p className="min-w-0 grow shrink basis-[240px] py-s1 text-body">
          {by} changed this card at {clockTime(at)}.
        </p>
        <Button kind="outline" className="min-h-hit py-0" onClick={onShow} data-testid="show-new-version">
          Show the new version
        </Button>
      </div>
    </div>
  );
}

export function ClosedNotice({ closure, onNext }: { closure: Closure; onNext: () => void }) {
  return (
    <section role="status" className="mt-s5 rounded-panel border border-line-3 bg-panel px-s4 py-s4" data-testid="closed-notice">
      <p className="flex items-start gap-s2 text-body font-strong">
        <Icon name="lock" size="sm" className="mt-s1 flex-none text-ink-2" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {closure.by} closed this card at {clockTime(closure.at)}
          {closure.following ? ', on your instruction in chat: "' + closure.following + '".' : "."}
        </span>
      </p>
      <div className="mt-s3 flex flex-wrap items-center justify-between gap-s3 pl-s5">
        <p className="text-body text-ink-2">Nothing to answer.</p>
        <Button kind="primary" onClick={onNext} data-testid="next-card">
          Next card
        </Button>
      </div>
    </section>
  );
}
