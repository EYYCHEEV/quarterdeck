export const FILE_MIMES: Record<string, string | undefined> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", log: "text/plain", csv: "text/csv", json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export type FileInfo = { name: string; size: number; type: string };

export type FileKind = "image" | "file";

export function kindOf(info: FileInfo): FileKind {
  const extension = extensionOf(info.name);
  return Object.hasOwn(FILE_MIMES, extension) && FILE_MIMES[extension]?.startsWith("image/") ? "image" : "file";
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}
