import { href } from "../../domain/routes";
import { ChatGlyph } from "../../ui/chat-glyph";
import { FloatAction, FloatCapsule, FloatTop } from "../../ui/float";
import { FloatBack } from "../../ui/float-back";

const DIVIDER = { width: 1, height: 24, background: "var(--color-line-3)" };

export function PhoneTop({
  answered,
  waiting,
  owner,
  ready,
  onAnswered,
  onTalk,
  onMore,
}: {
  answered: boolean;
  waiting: string;
  owner: string;
  ready: boolean;
  onAnswered: () => void;
  onTalk: () => void;
  onMore: () => void;
}) {
  return (
    <FloatTop>
      <FloatBack to={href.queue()} onClick={answered ? onAnswered : undefined}>
        {answered ? "Answered" : "Queue" + waiting}
      </FloatBack>
      {ready && (
        <FloatCapsule label="Card actions">
          <FloatAction glyph={<ChatGlyph />} label={"Talk to " + owner} onClick={onTalk} data-testid="talk-to-top">
            Talk
          </FloatAction>
          <span aria-hidden="true" style={DIVIDER} />
          <FloatAction glyph="more" label="More: words, links, full notes, labels" onClick={onMore} data-testid="more-top" />
        </FloatCapsule>
      )}
    </FloatTop>
  );
}
