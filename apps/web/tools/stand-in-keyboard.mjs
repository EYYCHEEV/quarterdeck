export function standInKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport || window.qdStandInKeyboard) return;
  window.qdStandInKeyboard = true;
  const proto = Object.getPrototypeOf(viewport);
  const real = Object.getOwnPropertyDescriptor(proto, "height");
  let up = false;
  Object.defineProperty(proto, "height", {
    configurable: true,
    get() {
      return real.get.call(this) - (up ? 320 : 0);
    },
  });
  const set = (next) => {
    if (up === next) return;
    up = next;
    viewport.dispatchEvent(new Event("resize"));
  };
  const typing = (target) => target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
  document.addEventListener("focusin", (event) => set(typing(event.target)));
  document.addEventListener("focusout", () => set(false));
  set(typing(document.activeElement));
}
