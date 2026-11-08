const POLICY = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const REMOVED_ELEMENTS = "meta[http-equiv], base, iframe, frame, object, embed, portal, link, form";
const REMOVED_ATTRIBUTES = new Set(["href", "xlink:href", "action", "formaction", "ping", "srcset"]);
const REMOVED_ANIMATIONS = new Set(["animate", "set", "animatemotion", "animatetransform", "discard"]);

export function pageDocument(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const roots: ParentNode[] = [document];
  for (const root of roots) {
    for (const element of root.querySelectorAll(REMOVED_ELEMENTS)) element.remove();
    for (const element of root.querySelectorAll("*")) {
      if (REMOVED_ANIMATIONS.has(element.localName.toLowerCase())) {
        element.remove();
        continue;
      }
      if (element instanceof HTMLTemplateElement) roots.push(element.content);
      for (let index = element.attributes.length - 1; index >= 0; index--) {
        const attribute = element.attributes[index];
        if (REMOVED_ATTRIBUTES.has(attribute.name.toLowerCase())) element.removeAttributeNode(attribute);
      }
    }
  }
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta name="referrer" content="no-referrer">${document.documentElement.outerHTML}`;
}
