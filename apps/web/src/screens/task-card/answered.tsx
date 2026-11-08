import { choiceText } from "../../domain/query";
import { clockTime, dueShort } from "../../domain/time";
import type { Card } from "../../domain/types";
import { Icon } from "../../ui/icon";

export function AnsweredRecord({ card }: { card: Card }) {
  const answer = card.answer;
  if (!answer) return null;
  const choice = answer.choice;
  const label = choice.kind === "option" ? card.options.find((option) => option.letter === choice.letter)?.label : null;
  const what = choice.kind === "option" ? choice.letter + "." + (label ? " " + label : "") : choiceText(choice);
  return (
    <section className="mt-5 rounded-panel border border-line bg-panel px-3.5 py-3" aria-label="Your answer" data-testid="answered-record">
      <p className="flex items-start gap-2.5 text-body font-semibold">
        <Icon name="check" size="sm" className="mt-[3px] flex-none text-green" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{"You answered " + what}</span>
      </p>
      <div className="mt-1 grid gap-1 pl-[26px] text-note text-ink-2">
        <p>
          {dueShort(answer.at)}
          {answer.note && <> · note: {answer.note}</>}
        </p>
        {answer.waitingOn && <p className="text-ink">Waiting on {answer.waitingOn}</p>}
        {answer.outcome && (
          <p className="text-ink" data-testid="answer-outcome">
            {answer.outcome.by}: {answer.outcome.text} · {clockTime(answer.outcome.at)}
          </p>
        )}
      </div>
    </section>
  );
}
