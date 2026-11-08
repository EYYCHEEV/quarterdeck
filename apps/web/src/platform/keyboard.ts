export type ReturnKey = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey" | "isComposing" | "keyCode">;

export function enterSends(event: ReturnKey, keyboardUp: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !event.shiftKey && !event.altKey && !keyboardUp;
}
