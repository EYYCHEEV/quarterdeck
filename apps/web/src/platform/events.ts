export type EventConnection = "open" | "reconnecting" | "closed";

export type EventStream = {
  readonly readyState?: number;
  addEventListener: (name: string, listener: (event: { data: unknown }) => void) => void;
  close: () => void;
};

export function watchEvents(url: string, name: string, onEvent: (data: string) => void, open: (address: string) => EventStream = (address) => new EventSource(address), onError?: () => void, onState?: (state: EventConnection) => void): () => void {
  const stream = open(url);
  let active = true;
  stream.addEventListener(name, (event) => { if (active) onEvent(String(event.data)); });
  if (onState) stream.addEventListener("open", () => { if (active) onState("open"); });
  if (onError || onState) stream.addEventListener("error", () => {
    if (!active) return;
    onState?.(stream.readyState === 2 ? "closed" : "reconnecting");
    if (active) onError?.();
  });
  return () => {
    if (!active) return;
    active = false;
    stream.close();
  };
}
