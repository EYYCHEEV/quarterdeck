import type { Page, PublicPage } from "./types";

export type PageRandomSource = (bytes: Uint8Array) => void;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const randomBytes: PageRandomSource = (bytes) => globalThis.crypto.getRandomValues(bytes);

export function marksOf(page: Page): string[] {
  return [...(page.live ? ["Live"] : []), ...(page.public ? ["Public"] : [])];
}

export function publishRefusal(page: Page, version: number): string | null {
  if (!page.file) return "That Page has no file yet.";
  if (version !== page.current && !page.versions.some((item) => item.n === version && item.kept && item.file)) return "That version is not kept.";
  if (page.public?.removal === "pending") return "The public copy is still being removed.";
  if (page.public?.version === version) return "That version is already public.";
  return null;
}

export function publicAddress(random: PageRandomSource = randomBytes): string {
  const bytes = new Uint8Array(16);
  random(bytes);
  let address = "https://pages-public.example.com/p/";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      address += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits) address += BASE32[value << (5 - bits)];
  return address;
}

export function fileOfVersion(page: Page, version: number): string | null {
  const known = page.versions.find((item) => item.n === version);
  if (known) return known.file;
  return version === page.current ? page.file : null;
}

export function publish(page: Page, version: number, at: string, mintAddress: () => string = publicAddress): PublicPage {
  return { version, madeBy: "Captain", madeAt: at, link: page.public?.link ?? mintAddress(), removal: "none" };
}

export const makePrivate = (page: Page): PublicPage | null => (page.public ? { ...page.public, removal: "pending" } : null);
