export type TextPart = { text: string; mark: boolean };

const LISTED = "\\u061C\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF";
const ANY = new RegExp("[" + LISTED + "]");
const EACH = new RegExp("[" + LISTED + "]", "g");
const SPLIT = new RegExp("([" + LISTED + "])");

const markOf = (character: string): string => "\\u{" + character.charCodeAt(0).toString(16).toUpperCase() + "}";

export const hasHidden = (text: string): boolean => ANY.test(text);

export const shownText = (text: string): string => (ANY.test(text) ? text.replace(EACH, markOf) : text);

export function hiddenParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  text.split(SPLIT).forEach((piece, at) => {
    if (at % 2 === 1) parts.push({ text: markOf(piece), mark: true });
    else if (piece !== "") parts.push({ text: piece, mark: false });
  });
  return parts;
}
