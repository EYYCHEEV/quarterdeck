const shifts = new Map<string, number>();
let pen: CanvasRenderingContext2D | null | undefined;

export default function centreInkAcross(el: HTMLElement) {
  const { fontWeight, fontSize, fontFamily, letterSpacing } = getComputedStyle(el);
  const font = fontWeight + " " + fontSize + " " + fontFamily;
  const text = el.textContent ?? "";
  const key = font + letterSpacing + text;
  const measure = () => {
    pen ??= document.createElement("canvas").getContext("2d");
    if (!pen) return undefined;
    pen.font = font;
    pen.letterSpacing = letterSpacing;
    const ink = pen.measureText(text);
    return (ink.width + ink.actualBoundingBoxLeft - ink.actualBoundingBoxRight) / parseFloat(fontSize);
  };
  const place = (shift: number | undefined) => {
    if (shift !== undefined) el.style.marginLeft = shift + "em";
  };
  const kept = shifts.get(key);
  if (kept !== undefined) {
    place(kept);
    return;
  }
  place(measure());
  const settle = () => {
    const shift = shifts.get(key) ?? measure();
    if (shift === undefined) return;
    shifts.set(key, shift);
    place(shift);
  };
  document.fonts.load(font, text).then(settle, settle);
}
