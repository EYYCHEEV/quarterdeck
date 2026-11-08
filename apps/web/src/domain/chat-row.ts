import { kindOf, type FileInfo } from "./file-kind";
import { plainText } from "./markdown";

export type RowMessage = { from: "captain" | "bot"; text: string; attachments?: FileInfo[] };

const counted = (n: number, one: string, many: string) => (n === 1 ? "1 " + one : n + " " + many);

function carried(attachments: FileInfo[]): string {
  const pictures = attachments.filter((item) => kindOf(item) === "image").length;
  const files = attachments.length - pictures;
  if (!files) return pictures === 1 ? "Picture" : pictures + " pictures";
  if (!pictures) return files === 1 ? attachments[0].name : files + " files";
  return counted(pictures, "picture", "pictures") + " and " + counted(files, "file", "files");
}

export function rowPreview(last: RowMessage): string {
  const said = plainText(last.text);
  const kept = last.attachments ?? [];
  const line = said || (kept.length ? carried(kept) : "");
  return line && last.from === "captain" ? "You: " + line : line;
}
