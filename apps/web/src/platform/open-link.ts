export function openOutside(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export function outsideLink(url: string): { href: string; target: "_blank"; rel: "noopener noreferrer" } {
  return { href: url, target: "_blank", rel: "noopener noreferrer" };
}
