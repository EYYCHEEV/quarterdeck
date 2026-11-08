function writeWithSelection(value: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  Object.assign(field.style, { position: "fixed", top: "0", left: "0", opacity: "0", fontSize: "16px" });
  const before = document.activeElement;
  document.body.appendChild(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    if (before instanceof HTMLElement) before.focus({ preventScroll: true });
  }
}

export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      return writeWithSelection(value);
    }
  }
  return writeWithSelection(value);
}
