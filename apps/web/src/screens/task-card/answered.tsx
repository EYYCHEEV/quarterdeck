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
    <section className="mt-s4 rounded-panel border border-line bg-panel px-s3 py-s3" aria-label="Your answer" data-testid="answered-record">
      <p className="flex items-start gap-s2 text-body font-strong">
        <Icon name="check" size="sm" className="mt-hair flex-none text-moving" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{"You answered " + what}</span>
      </p>
      <div className="mt-s1 grid gap-s1 pl-s5 text-body text-ink-2">
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
