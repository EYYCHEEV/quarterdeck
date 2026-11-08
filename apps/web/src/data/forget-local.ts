import { clearSession, type ChatDraft, type PendingSend } from "./session";
import { clearSettings } from "./settings";

export function forgetSession(): void {
  for (const [key, value] of clearSession()) {
    if (key.startsWith("chat.draft.")) for (const item of (value as ChatDraft).files) URL.revokeObjectURL(item.url);
    if (key.startsWith("chat.pending.")) for (const item of value as PendingSend[]) for (const preview of item.previews) URL.revokeObjectURL(preview.url);
  }
}

export function forgetLocal(): void {
  forgetSession();
  clearSettings();
}
