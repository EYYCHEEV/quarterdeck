import { useState } from "react";
import type { ChoiceGroup } from "./choices";
import { cx } from "./cx";
import { Icon } from "./icon";
import { ChoiceRow, RadioMark } from "./option";

const HINTS: Record<string, string> = { label: "Your own types", due: "Overdue, today, this week, none" };

function ShowRow({ group, current, onPick }: { group: ChoiceGroup; current: string; onPick: (value: string) => void }) {
  return (
    <div role="radiogroup" aria-label={group.title} className="flex min-h-12 items-center gap-3 px-3" data-testid="filter-show-row">
      <span className="w-[76px] flex-none text-body text-ink-2">{group.title}</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-1">
        {group.choices.map((choice) => {
          const on = current === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(choice.value)}
              className={cx("flex min-h-11 cursor-pointer items-center gap-2 rounded-small px-2 text-body hover:bg-raised", on ? "text-ink" : "text-ink-2")}
            >
              <RadioMark on={on} neutral small />
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PickRow({
  group,
  current,
  open,
  onToggle,
  onPick,
}: {
  group: ChoiceGroup;
  current: string | undefined;
  open: boolean;
  onToggle: () => void;
  onPick: (value: string | undefined) => void;
}) {
  const label = group.choices.find((choice) => choice.value === current)?.label ?? null;
  const hint = HINTS[group.key];
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-small px-3 py-1 text-left text-body hover:bg-raised"
        data-testid={"filter-" + group.key}
      >
        <span className="w-[76px] flex-none text-ink-2">{group.title}</span>
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate", label && "font-semibold")}>{label ?? "All"}</span>
          {hint && !label && <span className="block text-small text-ink-3">{hint}</span>}
        </span>
        <Icon name={open ? "chevD" : "chevR"} size="sm" className="text-ink-3" />
      </button>
      {open && (
        <div role="radiogroup" aria-label={group.title} className="grid pb-1 pl-[88px]">
          <ChoiceRow on={!current} label="All" onClick={() => onPick(undefined)} />
          {group.choices.map((choice) => (
            <ChoiceRow key={choice.value} on={current === choice.value} label={choice.label} onClick={() => onPick(choice.value)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Rows({ groups, value, onPick }: { groups: ChoiceGroup[]; value: (key: string) => string | undefined; onPick: (key: string, value: string | undefined) => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const show = groups.find((group) => group.key === "show");
  return (
    <div className="grid gap-0.5 pb-1">
      {show && <ShowRow group={show} current={value("show") ?? "waiting"} onPick={(choice) => onPick("show", choice === "waiting" ? undefined : choice)} />}
      {groups
        .filter((group) => group.key !== "show")
        .map((group) => (
          <PickRow
            key={group.key}
            group={group}
            current={value(group.key)}
            open={openKey === group.key}
            onToggle={() => setOpenKey(openKey === group.key ? null : group.key)}
            onPick={(choice) => {
              onPick(group.key, choice);
              setOpenKey(null);
            }}
          />
        ))}
    </div>
  );
}
