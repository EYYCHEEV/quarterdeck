declare const inspected: unique symbol;

export type InspectedFile = File & { readonly [inspected]: true };
export type FileInspection = { ok: true; file: InspectedFile; detectedType: string } | { ok: false; reason: string };
export type Refusal = { name: string | null; why: string };
export type FileAdmission = { accepted: InspectedFile[]; refused: Refusal[] };
export type PrepareFiles = (files: File[], alreadyAttached: number, attachedBytes?: number) => Promise<FileAdmission>;

export const MAX_FILES = 10;
export const FILE_LIMIT_TEXT = "A message can carry up to " + MAX_FILES + " files.";
export const notAdded = (name: string): string => "Not added: " + name + ".";
export const refusalText = (refusal: Refusal): string => (refusal.name === null ? refusal.why : notAdded(refusal.name) + " " + refusal.why);

const inspections = new WeakMap<File, Promise<FileInspection>>();

export function cachedInspection(file: File): Promise<FileInspection> | undefined {
  return inspections.get(file);
}

export function cacheInspection(file: File, inspection: Promise<FileInspection>) {
  inspections.set(file, inspection);
}
