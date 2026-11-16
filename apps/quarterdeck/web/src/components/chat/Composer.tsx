import type { ClipboardEvent } from "react";

import { type DraftStore, useDraft } from "../../stores/draftStore.ts";

export const LONG_PASTE_CHARS = 20_000;

interface ComposerProps {
  readonly chatId: string;
  readonly chatName: string;
  readonly drafts: DraftStore;
}

export function Composer(props: ComposerProps) {
  const text = useDraft(props.drafts, props.chatId);
  const catchLongPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = event.clipboardData.getData("text/plain");
    if (pasted.length <= LONG_PASTE_CHARS) return;
    event.preventDefault();
    const box = event.currentTarget;
    const lines = pasted.replace(/\r\n?/g, "\n");
    const caret = box.selectionStart + lines.length;
    box.value = box.value.slice(0, box.selectionStart) + lines + box.value.slice(box.selectionEnd);
    box.setSelectionRange(caret, caret);
    if (caret === box.value.length) box.scrollTop = box.scrollHeight;
    props.drafts.setDraft(props.chatId, box.value);
  };
  return (
    <form className="composer" onSubmit={(event) => event.preventDefault()}>
      <div className="composer-box">
        <textarea
          className="tx-input w-full"
          aria-label={`Message ${props.chatName}`}
          rows={3}
          value={text}
          onChange={(event) => props.drafts.setDraft(props.chatId, event.target.value)}
          onPaste={catchLongPaste}
        />
      </div>
    </form>
  );
}
