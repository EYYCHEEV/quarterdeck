import { ChoiceRow } from "./option";

export type ChoiceGroup = { key: string; title: string; choices: { value: string; label: string; detail?: string }[] };

export function ChoiceGroups({
  groups,
  value,
  onPick,
  any = "Any",
}: {
  groups: ChoiceGroup[];
  value: (key: string) => string | undefined;
  onPick: (key: string, choice: string | undefined) => void;
  any?: string | null;
}) {
  return (
    <div className="grid gap-2 pb-1">
      {groups.map((group) => (
        <div key={group.key} role="radiogroup" aria-label={group.title} className="grid">
          {groups.length > 1 && <h3 className="eyebrow px-3 pt-3 pb-1">{group.title}</h3>}
          {any !== null && <ChoiceRow on={!value(group.key)} label={any} onClick={() => onPick(group.key, undefined)} />}
          {group.choices.map((choice) => (
            <ChoiceRow key={choice.value} on={value(group.key) === choice.value} label={choice.label} detail={choice.detail} onClick={() => onPick(group.key, choice.value)} />
          ))}
        </div>
      ))}
    </div>
  );
}
