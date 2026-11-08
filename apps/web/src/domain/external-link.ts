export const BLOCKED_LINK = "Link blocked: not a safe address";

function privateDestination(hostname: string): boolean {
  const host = hostname.replace(/\.+$/, "");
  if (host.startsWith("[")) return !/^\[[23][0-9a-f]{3}:/.test(host);
  if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const [a, b] = host.split(".", 2).map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function webAddress(url: string): URL | null {
  try {
    const address = new URL(url);
    return address.protocol === "https:" && !address.username && !address.password && !privateDestination(address.hostname) ? address : null;
  } catch {
    return null;
  }
}
