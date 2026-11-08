const shifts = new Map<string, number>();
let pen: CanvasRenderingContext2D | null | undefined;

export default function centreInkAcross(el: HTMLElement) {
  const { fontWeight, fontSize, fontFamily, letterSpacing } = getComputedStyle(el);
  const font = fontWeight + " " + fontSize + " " + fontFamily;
  const text = el.textContent ?? "";
  const key = font + letterSpacing + text;
  let shift = shifts.get(key);
  if (shift === undefined) {
    pen ??= document.createElement("canvas").getContext("2d");
    if (!pen) return;
    pen.font = font;
    pen.letterSpacing = letterSpacing;
    const ink = pen.measureText(text);
    shift = (ink.width + ink.actualBoundingBoxLeft - ink.actualBoundingBoxRight) / parseFloat(fontSize);
    shifts.set(key, shift);
  }
  el.style.marginLeft = shift + "em";
}
