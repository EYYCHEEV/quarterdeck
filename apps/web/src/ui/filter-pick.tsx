import { useState } from "react";
import { ChoiceGroups, type ChoiceGroup } from "./choices";
import { Sheet } from "./overlay";
import { Toggle } from "./toggle";

export function FilterPick({
  groups,
  count,
  value,
  onPick,
  onClear,
  wide,
  disabled,
}: {
  groups: ChoiceGroup[];
  count: number;
  value: (key: string) => string | undefined;
  onPick: (key: string, value: string | undefined) => void;
  onClear: () => void;
  wide: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Toggle icon="filter" open={open} onClick={() => setOpen(!open)} disabled={disabled} data-testid="filter-btn">
        {count ? "Filter " + count : "Filter"}
      </Toggle>
      {open && (
        <Sheet title="Filter" pop={wide ? "filter-menu" : "filter-sheet"} wide={wide} onClose={() => setOpen(false)} onClear={onClear}>
          <ChoiceGroups groups={groups} value={value} onPick={onPick} />
        </Sheet>
      )}
    </>
  );
}
