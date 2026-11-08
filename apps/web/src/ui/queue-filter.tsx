import { lazy, Suspense, useState } from "react";
import { Button } from "./button";
import type { ChoiceGroup } from "./choices";
import { Sheet } from "./overlay";
import { Toggle } from "./toggle";

const Rows = lazy(() => import("./filter-rows").then((m) => ({ default: m.Rows })));

export function QueueFilter({
  groups,
  count,
  value,
  onPick,
  onClear,
  wide,
  disabled,
  resultText,
}: {
  groups: ChoiceGroup[];
  count: number;
  value: (key: string) => string | undefined;
  onPick: (key: string, value: string | undefined) => void;
  onClear: () => void;
  wide: boolean;
  disabled?: boolean;
  resultText: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Toggle icon="filter" open={open} onClick={() => setOpen(!open)} disabled={disabled} data-testid="filter-btn">
        {count ? "Filter " + count : "Filter"}
      </Toggle>
      {open && (
        <Suspense fallback={null}>
          <Sheet
            title="Filter"
            menu
            pop={wide ? "filter-menu" : "filter-sheet"}
            wide={wide}
            onClose={() => setOpen(false)}
            onClear={wide && !count ? undefined : onClear}
            footer={
              <Button kind="primary" block onClick={() => setOpen(false)} data-testid="filter-result">
                {resultText}
              </Button>
            }
          >
            <Rows groups={groups} value={value} onPick={onPick} />
          </Sheet>
        </Suspense>
      )}
    </>
  );
}
