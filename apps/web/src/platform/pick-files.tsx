import { useRef, type ChangeEvent, type ReactNode } from "react";

export type PickSource = "photos" | "camera" | "files";

export function useFilePicker(onPicked: (files: File[]) => void): { open: (source: PickSource) => void; inputs: ReactNode } {
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const list = [...(event.target.files ?? [])];
    event.target.value = "";
    if (list.length) onPicked(list);
  };
  const open = (source: PickSource) => {
    (source === "photos" ? photos : source === "camera" ? camera : files).current?.click();
  };
  const inputs = (
    <>
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={picked} data-testid="pick-photos" />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={picked} data-testid="pick-camera" />
      <input ref={files} type="file" multiple hidden onChange={picked} data-testid="pick-files" />
    </>
  );
  return { open, inputs };
}
