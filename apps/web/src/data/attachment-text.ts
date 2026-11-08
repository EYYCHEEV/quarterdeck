import { fetchText } from "../platform/read-text";

export const READ_LIMIT = 100_000;

const MEDIA_BASES = __QD_PREVIEW__ ? ["evidence/media/", "chat/media/"] : ["/evidence/media/", "/chat/media/"];

export async function readAttachedText(url: string): Promise<{ text: string; cut: boolean }> {
  const page = new URL(location.href);
  const address = new URL(url, page);
  if (address.origin !== page.origin || (address.protocol !== "blob:" && (address.protocol !== page.protocol || !MEDIA_BASES.some((base) => address.pathname.startsWith(new URL(base, page).pathname))))) throw new Error("Attachment preview address refused");
  return fetchText(address.href, READ_LIMIT);
}
