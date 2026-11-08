import { useState, type ReactNode, type RefObject } from "react";
import type { CleanupDays } from "../../data/bots-hooks";
import { Button } from "../../ui/button";
import { SheetDialog } from "../../ui/sheet-dialog";

function Confirm({
  label,
  pop,
  title,
  children,
  cancel = "Cancel",
  confirm,
  danger,
  busy,
  onCancel,
  onConfirm,
  returnTo,
}: {
  label: string;
  pop: string;
  title: string;
  children: ReactNode;
  cancel?: string;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnTo?: RefObject<HTMLElement | null>;
}) {
  return (
    <SheetDialog label={label} pop={pop} onClose={onCancel} returnTo={returnTo}>
      <div className="sheet-body grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-5 pt-5">
        <h2 className="text-title leading-[1.25] font-bold tracking-[-.01em]">{title}</h2>
        {children}
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Button kind="plain" onClick={onCancel} data-autofocus="" data-testid="confirm-cancel">
            {cancel}
          </Button>
          <Button kind={danger ? "outline" : "primary"} disabled={busy} onClick={onConfirm} className={danger ? "sheet-danger text-red" : undefined} data-testid="confirm-yes">
            {confirm}
          </Button>
        </div>
      </div>
    </SheetDialog>
  );
}

export function RemoveBotDialog({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm label="Remove bot" pop="remove-bot" title={"Remove " + name + "?"} confirm="Remove bot" danger onCancel={onCancel} onConfirm={onConfirm}>
      <p className="text-body text-ink-2">Its mail is kept, read only. Only you can do this.</p>
    </Confirm>
  );
}

const TODAY: Record<CleanupDays, { files: number; size: string; since: string }> = {
  30: { files: 214, size: "1.1 GB", since: "Oct 4" },
  60: { files: 96, size: "0.6 GB", since: "Sep 4" },
  90: { files: 41, size: "0.3 GB", since: "Aug 5" },
};

const SAMPLE = [
  ["build.log", "Shelvorn to Alba", "Oct 2"],
  ["trace-0417.json", "Dr. Kivo to Iris", "Oct 1"],
  ["search-v2-shots.zip", "Alba to you", "Sep 29"],
  ["notes-draft.md", "Dale to Dr. Kivo", "Sep 27"],
];

export function CleanupDialog({ days, onCancel, onConfirm }: { days: CleanupDays; onCancel: () => void; onConfirm: () => void }) {
  const [listed, setListed] = useState(false);
  const today = TODAY[days];
  return (
    <Confirm label="Turn on cleanup" pop="cleanup" title="Turn on cleanup?" confirm="Turn on" onCancel={onCancel} onConfirm={onConfirm}>
      <p className="text-body text-ink" data-testid="cleanup-count">
        Today this would remove {today.files} files, {today.size}, none opened since {today.since}.
      </p>
      <p className="text-body font-semibold text-red">Removed files cannot be brought back.</p>
      <Button kind="ghost" onClick={() => setListed((on) => !on)} aria-expanded={listed} className="sheet-act-start" data-testid="cleanup-list">
        See the list
      </Button>
      {listed && (
        <ul className="settings-rows grid rounded-control border border-line bg-well" data-testid="cleanup-files">
          {SAMPLE.map(([file, between, when]) => (
            <li key={file} className="grid gap-0.5 px-3.5 py-2.5">
              <span className="flex items-baseline justify-between gap-3 text-meta">
                <b className="min-w-0 truncate font-semibold">{file}</b>
                <time className="flex-none text-small text-ink-3">{when}</time>
              </span>
              <span className="text-small text-ink-2">{between}</span>
            </li>
          ))}
          <li className="px-3.5 py-2.5 text-small text-ink-2">and {today.files - SAMPLE.length} more</li>
        </ul>
      )}
    </Confirm>
  );
}
