import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQd, useWorld } from "../../data/hooks";

import {
  askAgainLabel,
  askNewer,
  fileOfVersion,
  headParts,
  marksOf,
  menuItems,
  newerLine,
  PRIVATE_DATA_CHECK,
  PUBLIC_WARNINGS,
  publicLine,
  readyLine,
  readyVersion,
  refusalText,
  showReady,
  showVersion,
} from "../../domain/pages";
import { href } from "../../domain/routes";
import type { Page } from "../../domain/types";
import { outsideLink } from "../../platform/open-link";
import { Button } from "../../ui/button";
import { DocumentStyle, DocumentTop } from "../../ui/document";
import { Icon } from "../../ui/icon";
import { hrefFor } from "../../ui/link";
import { Sheet } from "../../ui/overlay";
import { CopyButton, ReferenceBar } from "../../ui/reference";
import { Dot } from "../../ui/row";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";
import { pageDocument } from "./page-document";
import { useViewing } from "./use-viewing";

const MENU_ROW = "inline-flex min-h-11 items-center gap-1.5 rounded-small px-2.5 text-tag font-medium text-ink-2 hover:bg-raised hover:text-ink";
const PANEL = "grid gap-3";

type Opener = "more" | "update";

type Asking = { version: number; opener: Opener };

function Marks({ page }: { page: Page }) {
  const marks = marksOf(page);
  return (
    <>
      {marks.includes("Live") && (
        <span className="document-mark document-live">
          <Icon name="live" size="xs" />
          Live
        </span>
      )}
      {marks.includes("Public") && <span className="document-mark document-public">Public</span>}
    </>
  );
}

function PublicPanel({
  page,
  panelRef,
  updateRef,
  onUpdate,
  onPrivate,
}: {
  page: Page;
  panelRef: RefObject<HTMLElement | null>;
  updateRef: RefObject<HTMLButtonElement | null>;
  onUpdate: () => void;
  onPrivate: () => void;
}) {
  const line = publicLine(page);
  if (!line) return null;
  return (
    <section ref={panelRef} tabIndex={-1} className={PANEL + " document-public-panel outline-none"} aria-label="Public link" data-testid="public-panel">
      <p className="flex flex-wrap items-center gap-x-2 font-semibold" data-testid="public-line">
        <Icon name="link" size="sm" className="flex-none text-ink-3" />
        {line.text}
      </p>
      <code className="font-mono text-small [overflow-wrap:anywhere] text-ink-2 select-all">{line.link}</code>
      {!line.removing && (
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={line.link} label="Copy public link" done="Copied public link" />
          <Button kind="plain" className="min-h-11 py-0" onClick={onPrivate} data-testid="make-private">
            Make private
          </Button>
        </div>
      )}
      {line.newer && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="public-newer">
          <span className="min-w-0 flex-1 text-ink-2">{line.newer}</span>
          <Button ref={updateRef} kind="plain" className="min-h-11 py-0" onClick={onUpdate} data-testid="update-public">
            Update public version
          </Button>
        </div>
      )}
    </section>
  );
}

function Confirm({
  version,
  newer,
  backRef,
  onPreview,
  onMake,
  onAskAgain,
  onBack,
}: {
  version: number;
  newer: number | null;
  backRef: RefObject<HTMLButtonElement | null>;
  onPreview: () => void;
  onMake: () => void;
  onAskAgain: () => void;
  onBack: () => void;
}) {
  return (
    <section role="group" aria-label="Make public" className={PANEL + " document-confirm"} data-testid="make-public-confirm">
      <p className="flex items-center gap-2 font-semibold">
        <Icon name="unblock" size="sm" />
        Make version {version} public?
      </p>
      <ul className="grid gap-1 pl-6 text-ink">
        {PUBLIC_WARNINGS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="flex items-center gap-2 text-ink">
        <Icon name="check" size="sm" className="text-green" />
        {PRIVATE_DATA_CHECK}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button kind="ghost" onClick={onPreview}>
          Preview public version
        </Button>
        <Button kind="primary" onClick={onMake} data-testid="make-public">
          Make public
        </Button>
        <Button ref={backRef} kind="plain" onClick={onBack}>
          Back
        </Button>
      </div>
      {newer !== null && (
        <div className="border-t border-line pt-3">
          <p>{newerLine(newer)}</p>
          <Button kind="plain" className="min-h-11 py-0" onClick={onAskAgain}>
            {askAgainLabel(newer)}
          </Button>
        </div>
      )}
    </section>
  );
}

function Viewer({ page, projectId, laneName, wide }: { page: Page; projectId: string; laneName: string | null; wide: boolean }) {
  const qd = useQd();
  const { viewing, setViewing, html, load, retry } = useViewing(page);
  const srcDoc = useMemo(() => (html === null ? undefined : pageDocument(html)), [html]);
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusNext, setFocusNext] = useState<{ target: () => HTMLElement | null } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const update = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) back.current?.focus();
  }, [asking]);

  useEffect(() => {
    focusNext?.target()?.focus();
  }, [focusNext]);

  const removing = page.public?.removal === "pending";
  useEffect(() => {
    if (!removing || !asking) return;
    setAsking(null);
    setFocusNext({ target: () => panel.current });
  }, [removing, asking]);

  const ready = readyVersion(page, viewing);
  const trying = viewing.trying !== null;
  const direct = new URL(hrefFor(href.page(projectId, page.ref)), location.href).href;
  const hasFile = fileOfVersion(page, viewing.shown) !== null;
  const show = () => setViewing(showReady(page, viewing));

  const change = async (work: () => Promise<void>, failure: string) => {
    setNotice(null);
    try {
      await work();
    } catch (error) {
      setNotice(refusalText(error, failure));
    }
  };
  const leave = (target: () => HTMLElement | null) => {
    setAsking(null);
    setFocusNext({ target });
  };
  const makePublic = (from: Asking) =>
    change(
      () => qd.publishPage(page.ref, from.version).then(() => leave(() => (from.opener === "update" ? panel.current : more.current))),
      "Not made public. Try again.",
    );
  const makePrivate = () => change(() => qd.unpublishPage(page.ref).then(() => setFocusNext({ target: () => panel.current })), "Not made private. Try again.");
  const preview = (version: number) => {
    setViewing(showVersion(viewing, version));
    frame.current?.scrollIntoView({ block: "start" });
  };

  return (
    <div className="document-surface" data-testid="page-viewer">
      <DocumentStyle />
      <DocumentTop
        to={href.pages(projectId)}
        label="Pages"
        screen="Page"
        tools={
          <>
            <a {...outsideLink(direct)} className="document-tool" data-testid="new-tab">
              <Icon name="external" size="sm" />
              New tab
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <button ref={more} type="button" aria-label="More" aria-expanded={menu} aria-haspopup="dialog" onClick={() => setMenu(!menu)} className="document-tool document-page-more" data-testid="page-more">
              <span aria-hidden="true">⋯</span>
            </button>
          </>
        }
        menu={
          menu && (
            <Sheet title="Page" pop={wide ? "page-menu" : "page-sheet"} wide={wide} onClose={() => setMenu(false)}>
              <ul className="grid gap-1 pb-1" data-testid="page-menu-items">
                {menuItems(page).map((item) => (
                  <li key={item.id} className="grid">
                    {item.id === "copy-link" && <CopyButton value={direct} label={item.label} done="Copied link" className="w-full justify-start py-2" />}
                    {item.id === "open" && (
                      <a {...outsideLink(direct)} className={MENU_ROW}>
                        {item.label}
                        <Icon name="external" size="xs" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    )}
                    {item.id === "make-public" && (
                      <Button
                        kind="ghost"
                        className="min-h-11 justify-start py-0 text-tag"
                        onClick={() => {
                          setMenu(false);
                          setAsking({ version: page.current, opener: "more" });
                        }}
                      >
                        {item.label}
                      </Button>
                    )}
                    {item.id === "copy-public" && page.public && <CopyButton value={page.public.link} label={item.label} done="Copied public link" className="w-full justify-start py-2" />}
                    {item.id === "make-private" && (
                      <Button
                        kind="ghost"
                        className="min-h-11 justify-start py-0 text-tag"
                        onClick={() => {
                          setMenu(false);
                          void makePrivate();
                        }}
                      >
                        {item.label}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Sheet>
          )
        }
      />
      <div className="document-body">
        <div className="document-reader-heading">
          <p className="document-kicker"><Icon name="page" size="sm" />Bot-made Page</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1>{page.title}</h1>
            <Marks page={page} />
          </div>
          <div className="document-reader-meta">
            <span className="document-reader-facts" data-testid="page-line">
              {headParts(page, laneName, qd.now()).map((part, n) => (
                <span key={n} className="inline-flex items-center gap-x-1.5">
                  {n > 0 && <Dot />}
                  {part}
                </span>
              ))}
            </span>
            <ReferenceBar code={page.ref} />
          </div>
        </div>
        <PublicPanel page={page} panelRef={panel} updateRef={update} onUpdate={() => setAsking({ version: page.current, opener: "update" })} onPrivate={() => void makePrivate()} />
        {asking && (
          <Confirm
            version={asking.version}
            newer={askNewer(page, asking.version)}
            backRef={back}
            onPreview={() => preview(asking.version)}
            onMake={() => void makePublic(asking)}
            onAskAgain={() => setAsking({ ...asking, version: page.current })}
            onBack={() => {
              setNotice(null);
              leave(() => (asking.opener === "update" ? (update.current ?? panel.current) : more.current));
            }}
          />
        )}
        {notice && (
          <p role="alert" className="mt-2 flex items-center gap-2 text-note text-red" data-testid="page-notice">
            <Icon name="alert" size="sm" />
            {notice}
          </p>
        )}
        {ready !== null && (
          <div role="status" className="document-version" data-testid="version-ready">
            <span className="min-w-0 flex-1 py-2">{readyLine(ready)}</span>
            <Button kind="plain" className="min-h-11 py-0" onClick={show} disabled={trying && load.state === "loading"}>
              Show
            </Button>
          </div>
        )}
        {load.state === "failed" && (
          <ErrorLine className="mt-3" retryLabel="Try again" onRetry={retry}>
            This Page did not load.
          </ErrorLine>
        )}
        <div className="document-frame-label"><span>Page</span><span>Version {viewing.shown}</span></div>
        {!hasFile ? (
          <Empty className="mt-3.5" testId="no-file">
            No file yet
          </Empty>
        ) : (
          <div
            ref={frame}
            className="document-frame"
            data-testid="page-frame"
          >
            {html !== null ? (
              <iframe title={page.title} srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" className="block size-full flex-1 border-0 bg-paper" />
            ) : (
              load.state !== "failed" && (
                <p className="m-auto text-meta text-paper-ink-2" role="status">
                  Loading the Page
                </p>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function PageScreen({ projectId, pageRef, wide }: { projectId: string; pageRef: string; wide: boolean }) {
  const { world, failed, retry } = useWorld();
  const page = world?.pages.find((item) => item.ref === pageRef && item.projectId === projectId) ?? null;
  const project = world?.projects.find((item) => item.id === projectId) ?? null;
  const addOnOff = __QD_FIXTURES__ && new URLSearchParams(location.search).get("fail")?.split(",").includes("pages-off");
  if (addOnOff && world && page)
    return (
      <div className="document-surface" data-testid="pages-off">
        <DocumentStyle />
        <DocumentTop to={href.pages(projectId)} label="Pages" screen="Page" />
        <div className="document-body">
          <p className="document-kicker">{project?.name ?? "Project"} · Pages</p>
          <section className="document-empty">
            <Icon name="page" />
            <h1>Pages isn't set up</h1>
            <p>This Quarterdeck has the Pages Add-on turned off.</p>
          </section>
        </div>
      </div>
    );
  if (!world || !page)
    return (
      <div className="document-surface">
        <DocumentStyle />
        <DocumentTop to={href.projects(projectId)} label={project?.name ?? "Projects"} screen="Page" />
        <div className="px-4 pt-2 wide:px-8">
          {failed ? <ErrorLine onRetry={retry}>Could not load this Page.</ErrorLine> : world ? <Empty>This Page is not in the example data.</Empty> : <LoadingBars rows={1} height={420} />}
        </div>
      </div>
    );
  const laneName = page.laneId ? (world.lanes.find((lane) => lane.id === page.laneId)?.name ?? null) : null;
  return <Viewer page={page} projectId={projectId} laneName={laneName} wide={wide} />;
}
