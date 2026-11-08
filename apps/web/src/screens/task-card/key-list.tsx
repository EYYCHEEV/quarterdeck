import { Dialog, DialogHead } from "../../ui/overlay";

function rows(owner: string, approval: boolean): [string, string][] {
  const answer: [string, string][] = approval
    ? []
    : [
        ["a  b  ...", "pick that option"],
        ["n", "None of these"],
        ["Enter", "send your pick"],
      ];
  return [["j / k", "next / previous card"], ...answer, ["t", "Talk to " + owner], ["\u2318K", "Search"], ["Esc", "close"]];
}

export function KeyList({ owner, approval, onClose }: { owner: string; approval: boolean; onClose: () => void }) {
  return (
    <Dialog label="Keys (Mac, or iPad with a keyboard)" pop="keys" onClose={onClose}>
      <DialogHead title="Keys (Mac, or iPad with a keyboard)" onClose={onClose} />
      <div className="overflow-y-auto px-4 py-3">
        <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-body">
          {rows(owner, approval).map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded-md border border-line-2 bg-control px-1.5 py-px font-mono text-meta whitespace-pre text-ink">{keys}</kbd>
              </dt>
              <dd className="m-0 text-ink-2">{what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-meta text-ink-2">Letter keys pause while you type a note.</p>
      </div>
    </Dialog>
  );
}
