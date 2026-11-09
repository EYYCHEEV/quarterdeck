import { sizeText } from "./chat-files";
import type { FileAdmission, InspectedFile, PrepareFiles } from "./file-inspection";

export type FileLimits = { fileBytes: number; messageBytes: number; count: number };

export const HEIC_TEXT = "This picture is in Apple's format. Choose it from Photos, or save it as a JPEG first.";
export const UPLOADING_TEXT = "Uploading...";
export const EXPIRED_TEXT = "Your files expired. Tap Try Again to upload them again.";
export const typeText = (name: string): string => "This file's type is not allowed: " + name;
export const bigText = (name: string): string => "This file is too big: " + name;
export const blockedText = (name: string): string => "This file was blocked: " + name;
export const countText = (count: number): string => "A message can carry up to " + count + " files.";
export const togetherText = (bytes: number): string => "These files are too big together. A message can carry up to " + sizeText(bytes) + ".";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};
const ALIASES: Record<string, readonly string[]> = {
  jpg: ["image/pjpeg"],
  jpeg: ["image/pjpeg"],
  md: ["text/x-markdown", "text/plain"],
  csv: ["application/vnd.ms-excel", "application/csv", "text/x-csv", "text/plain"],
  json: ["text/json"],
};
const UNNAMED: readonly string[] = ["", "application/octet-stream"];
const TEXT_TYPES: readonly string[] = ["text/plain", "text/markdown", "text/csv", "application/json"];
const HEIC_NAME = /\.hei[cf]$/i;
const HEIC_TYPE = /^image\/hei[cf](-sequence)?$/;
const HEAD_BYTES = 1024;
const PYTHON_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/;

export const PHOTO_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const FILE_ACCEPT = [...Object.keys(TYPES).map((extension) => "." + extension), ...new Set(Object.values(TYPES))].join(",");

const reportedOf = (type: string): string => type.split(";", 1)[0].trim().toLowerCase();

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function claimedType(name: string, reported: string): string | null {
  const extension = extensionOf(name);
  if (!Object.hasOwn(TYPES, extension)) return null;
  const claim = TYPES[extension];
  const given = reportedOf(reported);
  return given === claim || UNNAMED.includes(given) || (Object.hasOwn(ALIASES, extension) && ALIASES[extension].includes(given)) ? claim : null;
}

const isHeic = (file: File): boolean => HEIC_NAME.test(file.name) || HEIC_TYPE.test(reportedOf(file.type));

function startsWith(head: Uint8Array, text: string, at = 0): boolean {
  for (let n = 0; n < text.length; n += 1) if (head[at + n] !== text.charCodeAt(n)) return false;
  return true;
}

function magicOf(head: Uint8Array): string | null {
  if (startsWith(head, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (startsWith(head, "\xff\xd8\xff")) return "image/jpeg";
  if (startsWith(head, "GIF87a") || startsWith(head, "GIF89a")) return "image/gif";
  if (startsWith(head, "RIFF") && startsWith(head, "WEBP", 8)) return "image/webp";
  if (startsWith(head, "%PDF-")) return "application/pdf";
  return null;
}

function openingOf(head: Uint8Array): string | null {
  const data = startsWith(head, "\xef\xbb\xbf") ? head.subarray(3) : head;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data, { stream: true });
  } catch {
    return null;
  }
  if (text === "" || CONTROL.test(text)) return null;
  const opening = text.replace(PYTHON_SPACE, "");
  return opening.startsWith("<") || opening.startsWith("#!") ? null : opening;
}

export function headMatches(claim: string, head: Uint8Array): boolean {
  if (head.length === 0) return false;
  if (!TEXT_TYPES.includes(claim)) return magicOf(head) === claim;
  const opening = openingOf(head);
  if (opening === null) return false;
  return claim !== "application/json" || opening.startsWith("{") || opening.startsWith("[");
}

export function serverAdmit(limits: FileLimits): PrepareFiles {
  return async (files, alreadyAttached, attachedBytes = 0): Promise<FileAdmission> => {
    const accepted: InspectedFile[] = [];
    const refused: string[] = [];
    const refuse = (reason: string): void => {
      if (!refused.includes(reason)) refused.push(reason);
    };
    let bytes = attachedBytes;
    for (const file of files) {
      if (alreadyAttached + accepted.length >= limits.count) {
        refuse(countText(limits.count));
        continue;
      }
      if (isHeic(file)) {
        refuse(HEIC_TEXT);
        continue;
      }
      const claim = claimedType(file.name, file.type);
      if (claim === null || file.size === 0) {
        refuse(typeText(file.name));
        continue;
      }
      if (file.size > limits.fileBytes) {
        refuse(bigText(file.name));
        continue;
      }
      if (bytes + file.size > limits.messageBytes) {
        refuse(togetherText(limits.messageBytes));
        continue;
      }
      let head: Uint8Array;
      try {
        head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
      } catch {
        refuse(typeText(file.name));
        continue;
      }
      if (!headMatches(claim, head)) {
        refuse(typeText(file.name));
        continue;
      }
      bytes += file.size;
      accepted.push((file.type === claim ? file : new File([file], file.name, { type: claim, lastModified: file.lastModified })) as InspectedFile);
    }
    return { accepted, refused };
  };
}
