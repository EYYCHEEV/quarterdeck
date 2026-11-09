const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const BOTS_WORDS = {
  approve: "Approve in Backchannel for now.",
  history: "Joins history is in Backchannel for now.",
  waiting: "Approve it in Backchannel when it asks.",
  waitingHere: "Invite copied. When it asks, approve it under Pending joins.",
  list: "Could not load the bots.",
  failed: "Could not do that.",
  gone: "That request is no longer waiting.",
  inviteGone: "That invite has already ended.",
  name: "A bot name starts with a letter and uses a to z, 0 to 9 and hyphens, up to 32 characters.",
  rate: "Too many tries. Wait up to a minute, then try again.",
  token: "Not sent: there is no sign-in token.",
};

export const spacedCode = (code: string): string => code.slice(0, 4) + " " + code.slice(4);

export function endsText(endsAt: string, now: number): string {
  const left = Date.parse(endsAt) - now;
  if (left <= 0) return "ended";
  if (left < MINUTE) return "ends in under a minute";
  const minutes = Math.ceil(left / MINUTE);
  if (minutes < 60) return "ends in " + minutes + " min";
  return "ends in " + Math.max(1, Math.floor(left / HOUR)) + " h";
}
