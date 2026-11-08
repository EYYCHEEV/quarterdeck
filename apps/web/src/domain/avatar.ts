export const AVATAR_SLOTS = 5;

export function avatarSlot(id: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < id.length; at++) hash = Math.imul(hash ^ id.charCodeAt(at), 0x01000193) >>> 0;
  return (hash % AVATAR_SLOTS) + 1;
}

export function avatarColor(slot: number): string {
  return "var(--color-avatar-" + slot + ")";
}
