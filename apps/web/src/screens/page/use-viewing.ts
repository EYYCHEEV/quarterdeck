import { useEffect, useState } from "react";
import { useQd } from "../../data/hooks";
import { useSession } from "../../data/session";
import { fileOfVersion, landed, startViewing, type Viewing } from "../../domain/pages";
import type { Page } from "../../domain/types";

export type Load = { state: "idle" } | { state: "loading" } | { state: "failed" } | { state: "shown"; html: string };

type Got = { file: string; round: number; html: string | null };

export function useViewing(page: Page) {
  const qd = useQd();
  const [stored, setStored] = useSession<number | null>("page.reading." + page.ref, null);
  const [viewing, setViewing] = useState<Viewing>(() => startViewing(page, stored));
  const [html, setHtml] = useState<string | null>(null);
  const [got, setGot] = useState<Got | null>(null);
  const [round, setRound] = useState(0);
  const file = fileOfVersion(page, viewing.trying ?? viewing.shown);

  useEffect(() => {
    if (!file) return;
    let live = true;
    qd.openPage(file).then(
      (text) => live && setGot({ file, round, html: text }),
      () => live && setGot({ file, round, html: null }),
    );
    return () => {
      live = false;
    };
  }, [qd, file, round]);

  const current = got && got.file === file && got.round === round ? got : null;
  const load: Load = !file ? { state: "idle" } : !current ? { state: "loading" } : current.html === null ? { state: "failed" } : { state: "shown", html: current.html };
  const loaded = load.state === "shown" ? load.html : null;

  useEffect(() => {
    if (loaded === null) return;
    setHtml(loaded);
    if (viewing.trying !== null) {
      setStored(viewing.trying);
      setViewing(landed(viewing));
    }
  }, [loaded, viewing, setStored]);

  return { viewing, setViewing, html, load, retry: () => setRound((n) => n + 1) };
}
