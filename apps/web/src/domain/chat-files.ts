import { cacheInspection, cachedInspection, FILE_LIMIT_TEXT, MAX_FILES, type FileAdmission, type FileInspection, type InspectedFile } from "./file-inspection";
import { FILE_MIMES, extensionOf, type FileInfo } from "./file-kind";
import { whenText } from "./time";

export { MAX_FILES } from "./file-inspection";
export { extensionOf, kindOf, type FileInfo, type FileKind } from "./file-kind";

const KB = 1024;
const MB = 1024 * KB;

export const MAX_IMAGE_BYTES = 10 * MB;
export const MAX_FILE_BYTES = 50 * MB;
export const ALLOWED_KINDS = Object.keys(FILE_MIMES);
const TEXT_KINDS: Record<string, true | undefined> = { txt: true, md: true, log: true, csv: true, json: true };

export type FileCheck = { ok: true } | { ok: false; reason: string };

export function sizeText(bytes: number): string {
  const kb = bytes / KB;
  if (kb < 1000) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + " KB";
  const mb = kb / KB;
  return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + " MB";
}

export function normalizedFilename(name: string): string {
  const leaf = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = leaf.normalize("NFC").replace(/[<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_").trim().replace(/[. ]+$/, "");
  if (clean.length <= 180) return clean || "file";
  const dot = clean.lastIndexOf(".");
  const suffix = dot >= 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
  return clean.slice(0, 180 - suffix.length) + suffix;
}

export function checkFile(info: FileInfo, alreadyAttached: number): FileCheck {
  if (alreadyAttached >= MAX_FILES) return { ok: false, reason: FILE_LIMIT_TEXT };
  const name = normalizedFilename(info.name);
  if (info.size === 0) return { ok: false, reason: name + " is empty." };
  const extension = extensionOf(name);
  const expected = Object.hasOwn(FILE_MIMES, extension) ? FILE_MIMES[extension] : undefined;
  const image = expected?.startsWith("image/") ?? false;
  const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (info.size > limit) return { ok: false, reason: name + " is too large (" + sizeText(info.size) + "). " + (image ? "Pictures" : "Files") + " can be up to " + sizeText(limit) + "." };
  if (!ALLOWED_KINDS.includes(extension)) return { ok: false, reason: "Can't send " + name + " here. " + (extension ? "." + extension + " files are not allowed." : "It has no file kind.") };
  const reported = info.type.split(";", 1)[0].trim().toLowerCase();
  if (reported && reported !== "application/octet-stream" && reported !== expected && !(TEXT_KINDS[extension] === true && reported === "text/plain") && !(extension === "heic" && reported === "image/heif")) return { ok: false, reason: "Can't send " + name + " here. Its file kind does not match its name." };
  return { ok: true };
}

export async function admit(files: File[], alreadyAttached: number): Promise<FileAdmission> {
  const accepted: InspectedFile[] = [];
  const refused: string[] = [];
  for (const file of files) {
    const check = await inspectFile(file, alreadyAttached + accepted.length);
    if (check.ok) accepted.push(check.file);
    else if (!refused.includes(check.reason)) refused.push(check.reason);
  }
  return { accepted, refused };
}

function officeKind(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const first = Math.max(0, bytes.length - 65_557);
  for (; end >= first; end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < first) return null;
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) return null;
  const count = view.getUint16(end + 10, true);
  if (count !== view.getUint16(end + 8, true) || count > 4096) return null;
  const size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (at + size !== end) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let types = false;
  let word = false;
  let sheet = false;
  let slides = false;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50 || (view.getUint16(at + 8, true) & 1)) return null;
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    if (next > end || local + 30 > at || view.getUint32(local, true) !== 0x04034b50) return null;
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name === "[Content_Types].xml") types = true;
    if (name === "word/document.xml") word = true;
    if (name === "xl/workbook.xml") sheet = true;
    if (name === "ppt/presentation.xml") slides = true;
    at = next;
  }
  if (at !== end || !types || Number(word) + Number(sheet) + Number(slides) !== 1) return null;
  if (word) return "docx";
  return sheet ? "xlsx" : "pptx";
}

function detectedKind(bytes: Uint8Array, extension: string): string | null {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const end = new TextDecoder("latin1").decode(bytes.subarray(-32));
  if (bytes.length >= 45 && bytes[0] === 137 && prefix.slice(1, 8) === "PNG\r\n\u001a\n" && prefix.slice(12, 16) === "IHDR" && new TextDecoder("latin1").decode(bytes.subarray(-8, -4)) === "IEND") return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "jpeg";
  if (bytes.length >= 14 && /^GIF8[79]a/.test(prefix) && bytes.at(-1) === 59) return "gif";
  if (bytes.length >= 20 && prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP" && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length) return "webp";
  if (bytes.length >= 24 && prefix.slice(4, 8) === "ftyp") {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length || size % 4) return null;
    const decoder = new TextDecoder("latin1");
    for (let at = 8; at < size; at += 4) {
      if (at !== 12 && /^(?:heic|heix|hevc|hevx)$/.test(decoder.decode(bytes.subarray(at, at + 4)))) return "heic";
    }
    return null;
  }
  if (/^%PDF-[12]\.\d/.test(prefix) && /%%EOF\s*$/.test(end)) return "pdf";
  if (prefix.startsWith("PK\u0003\u0004")) return officeKind(bytes);
  if (prefix.startsWith("MZ") || prefix.startsWith("\u007fELF")) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) return null;
  const leading = text.trimStart();
  if (/^(?:#!|<(?:!doctype\s+html|html|head|body|script|svg|iframe)\b|(?:import|export|const|let|var|function|class)\s|(?:window|document|console)\s*[.(])/i.test(leading)) return null;
  if (extension === "json") {
    JSON.parse(text);
    return "json";
  }
  return "text";
}

export function inspectFile(file: File, alreadyAttached: number): Promise<FileInspection> {
  const metadata = checkFile(file, alreadyAttached);
  if (!metadata.ok) return Promise.resolve(metadata);
  const cached = cachedInspection(file);
  if (cached) return cached;
  const inspection = (async (): Promise<FileInspection> => {
    const name = normalizedFilename(file.name);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = extensionOf(name);
      const detected = detectedKind(bytes, extension);
      const kind = extension === "jpg" ? "jpeg" : extension;
      const matches = detected === "text" ? TEXT_KINDS[extension] === true : detected !== null && detected === kind;
      if (!matches) return { ok: false, reason: "Can't send " + name + " here. Its name and contents do not match." };
      const detectedType = FILE_MIMES[extension]!;
      const normalized = (file.name === name && file.type === detectedType ? file : new File([file], name, { type: detectedType, lastModified: file.lastModified })) as InspectedFile;
      const result: FileInspection = { ok: true, file: normalized, detectedType };
      if (normalized !== file) cacheInspection(normalized, Promise.resolve(result));
      return result;
    } catch {
      return { ok: false, reason: "Can't read " + name + " as its file kind." };
    }
  })();
  cacheInspection(file, inspection);
  return inspection;
}

const TEXT_EXTENSIONS: Record<string, true | undefined> = { log: true, txt: true, md: true, json: true, csv: true, tsv: true, yml: true, yaml: true, xml: true, toml: true, ini: true, ts: true, tsx: true, js: true, mjs: true, css: true, html: true, sh: true };

export function canRead(info: FileInfo): boolean {
  return info.type.startsWith("text/") || info.type === "application/json" || info.type === "application/xml" || TEXT_EXTENSIONS[info.name.split(".").pop()?.toLowerCase() ?? ""] === true;
}

export function pictureCaption(file: { name: string; alt?: string }, who: string, at: string, now: number): string {
  return (file.alt ?? file.name) + " · " + who + " " + whenText(at, now);
}
