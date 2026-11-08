type MediaRoot = "/evidence/media/" | "/chat/media/" | "evidence/media/" | "chat/media/";
type MediaKind = "image" | "video" | "file";

const MEDIA_ORIGIN = "https://media.invalid";
const FILES = {
  image: /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i,
  video: /\.(?:webm|mp4|og[gv])$/i,
  file: /\.(?:pdf|txt|md|log|csv|json|docx|xlsx|pptx|png|jpe?g|gif|webp|avif|bmp|heic|webm|mp4|og[gv])$/i,
} as const;

export function mediaPath(file: string, kind: MediaKind = "image", base: MediaRoot = "/evidence/media/"): string {
  const name = file.startsWith("media/") ? file.slice(6) : file;
  if (!name || /[/\\%?#:\u0000-\u001f\u007f]/u.test(name) || !FILES[kind].test(name)) return "";
  const absolute = base.startsWith("/");
  const root = absolute ? base : "/" + base;
  try {
    const address = new URL(root + encodeURIComponent(name), MEDIA_ORIGIN);
    if (address.origin !== MEDIA_ORIGIN || !address.pathname.startsWith(root)) return "";
    return absolute ? address.pathname : address.pathname.slice(1);
  } catch {
    return "";
  }
}
