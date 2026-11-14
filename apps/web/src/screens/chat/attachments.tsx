import { createContext, useContext, useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { readAttachedText } from "../../data/attachment-text";
import type { Attachment } from "../../data/chat-types";
import type { DraftFile } from "../../data/session";
import { canRead, kindOf, kindTile, shortName, sizeText, sizeToTenth, totalText } from "../../domain/chat-files";
import { notAdded, refusalText, type Refusal } from "../../domain/file-inspection";
import { blockedText } from "../../domain/files-r1";
import { outsideLink } from "../../platform/open-link";
import { ButtonLink, LinkButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";
import { Dialog, DialogHead } from "../../ui/overlay";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";

type Open = (file: Attachment, from: HTMLElement) => void;

const SERVER_ROW = "flex min-h-hit w-[min(100%,320px)] min-w-0 items-center gap-s2 rounded-key border border-line bg-panel px-s3 py-s2 text-left";

export const isPicture = (item: Attachment): boolean => (item.kind ? item.kind === "photo" : kindOf(item) === "image");

const settled = new Map<string, "loaded" | "failed">();
const settledHeard = new Set<() => void>();
let settledVersion = 0;

function settle(id: string, state: "loaded" | "failed" | null) {
  if ((settled.get(id) ?? null) === state) return;
  if (state === null) settled.delete(id);
  else settled.set(id, state);
  settledVersion += 1;
  for (const heard of [...settledHeard]) heard();
}

function hearSettled(onChange: () => void) {
  settledHeard.add(onChange);
  return () => settledHeard.delete(onChange);
}

export const PhotoTurn = createContext<string | null>(null);

export function usePhotoTurn(order: string[]): string | null {
  useSyncExternalStore(hearSettled, () => settledVersion);
  return order.find((id) => !settled.has(id)) ?? null;
}

function FailedTile({ name, onRetry }: { name: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-[112px] w-[112px] flex-col justify-between gap-s1 rounded-key border border-line bg-raised p-s2" data-testid="chat-picture-failed">
      <span className="text-meta font-strong [overflow-wrap:anywhere]">{name}</span>
      <span className="text-meta text-ink-2">This picture did not load.</span>
      {onRetry && <LinkButton onClick={onRetry}>Try again</LinkButton>}
    </div>
  );
}

function PictureTile({ picture, onOpen }: { picture: Attachment; onOpen: Open }) {
  const [failed, setFailed] = useState(() => !picture.url);
  const [tries, setTries] = useState(0);
  if (failed)
    return (
      <FailedTile
        name={picture.name}
        onRetry={
          picture.url
            ? () => {
                setFailed(false);
                setTries(tries + 1);
              }
            : undefined
        }
      />
    );
  return (
    <button type="button" onClick={(event) => onOpen(picture, event.currentTarget)} aria-label={"Open " + (picture.alt ?? picture.name)} className="flex-none cursor-pointer rounded-key" data-testid="chat-picture-open">
      <img key={tries} src={picture.url} alt={picture.alt ?? picture.name} decoding="sync" onError={() => setFailed(true)} className="size-[112px] rounded-key border border-line object-cover" data-testid="chat-picture" />
    </button>
  );
}

function ServerPhoto({ picture, onOpen }: { picture: Attachment; onOpen: Open }) {
  const turn = useContext(PhotoTurn);
  const state = useSyncExternalStore(hearSettled, () => settled.get(picture.id) ?? null);
  if (state === "failed") return <FailedTile name={picture.name} onRetry={() => settle(picture.id, null)} />;
  if (state === null && turn !== picture.id) return <div role="img" aria-label={picture.alt ?? picture.name} className="size-[112px] flex-none rounded-key border border-line bg-raised" data-testid="chat-picture-wait" />;
  return (
    <button type="button" onClick={(event) => onOpen(picture, event.currentTarget)} aria-label={"Open " + (picture.alt ?? picture.name)} className="flex-none cursor-pointer rounded-key" data-testid="chat-picture-open">
      <img src={picture.url} alt={picture.alt ?? picture.name} decoding="sync" onLoad={() => settle(picture.id, "loaded")} onError={() => settle(picture.id, "failed")} className="size-[112px] rounded-key border border-line object-cover" data-testid="chat-picture" />
    </button>
  );
}

export function AttachmentList({ items, align, onOpen }: { items: Attachment[]; align: "start" | "end"; onOpen: Open }) {
  const pictures = items.filter(isPicture);
  const files = items.filter((item) => !isPicture(item));
  return (
    <div className={cx("grid max-w-full gap-s2", align === "end" ? "justify-items-end" : "justify-items-start")} data-testid="chat-attachments">
      {pictures.length > 0 && (
        <div className={cx("flex flex-wrap gap-s2", align === "end" && "justify-end")}>
          {pictures.map((picture) => (picture.kind ? <ServerPhoto key={picture.id} picture={picture} onOpen={onOpen} /> : <PictureTile key={picture.id} picture={picture} onOpen={onOpen} />))}
        </div>
      )}
      {files.map((file) =>
        file.kind === "blocked" ? (
          <p key={file.id} className={cx(SERVER_ROW, "text-ink-2")} data-testid="chat-file-blocked">
            <span className="flex min-w-0 flex-1 items-start gap-s2 text-body">
              <span className="flex h-[1lh] flex-none items-center">
                <Icon name="alert" size="sm" className="text-ink-3" />
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{blockedText(file.name)}</span>
            </span>
          </p>
        ) : file.kind === "file" ? (
          <a key={file.id} {...outsideLink(file.url)} className={cx(SERVER_ROW, "cursor-pointer hover:border-line-3")} data-testid="chat-file">
            <Icon name="file" size="sm" className="flex-none text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-body" data-truncates="">{file.name}</span>
            <span className="flex-none text-meta text-ink-3">{sizeText(file.size)}</span>
          </a>
        ) : (
          <button
            key={file.id}
            type="button"
            onClick={(event) => onOpen(file, event.currentTarget)}
            className="flex min-h-hit w-[min(100%,320px)] cursor-pointer items-center gap-s2 rounded-key border border-line bg-panel px-s3 py-s2 text-left hover:border-line-3"
            data-testid="chat-file"
          >
            <Icon name="file" size="sm" className="text-ink-3" />
            <span className="min-w-0 flex-1 text-body [overflow-wrap:anywhere]">{file.name}</span>
            <span className="flex-none text-meta text-ink-3">{sizeText(file.size)}</span>
          </button>
        ),
      )}
    </div>
  );
}

export function FileViewer({ file, returnTo, onClose }: { file: Attachment; returnTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const readable = canRead(file);
  const [text, setText] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const [failed, setFailed] = useState(() => !file.url);
  useEffect(() => {
    if (!readable || !file.url) return;
    let live = true;
    readAttachedText(file.url).then(
      (read) => {
        if (!live) return;
        setText(read.text);
        setCut(read.cut);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [file.url, readable]);
  return (
    <Dialog label={file.name} pop="file-viewer" onClose={onClose} returnTo={returnTo}>
      <DialogHead title={<span className="[overflow-wrap:anywhere]">{file.name}</span>} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-s4 py-s3">
        <p className="mb-s3 flex items-center gap-s1 text-meta text-ink-2">
          <Icon name="lock" size="xs" />
          Read-only · {sizeText(file.size)}
        </p>
        {failed ? (
          <ErrorLine>Could not open this file.</ErrorLine>
        ) : !readable ? (
          <Empty>No preview for this kind of file.</Empty>
        ) : text === null ? (
          <LoadingBars rows={1} height={96} />
        ) : (
          <>
            <pre tabIndex={0} className="m-0 overflow-x-auto rounded-key border border-line bg-side px-s3 py-s3 font-mono text-meta leading-body whitespace-pre-wrap [overflow-wrap:anywhere] text-ink" data-testid="file-text">
              {text}
            </pre>
            {cut && (
              <p className="mt-s2 text-meta text-ink-2" data-testid="file-cut">
                Showing the first part only. Download for the whole file.
              </p>
            )}
          </>
        )}
      </div>
      {file.url && (
        <div className="flex-none border-t border-line p-s3">
          <ButtonLink href={file.url} download={file.name} block data-testid="file-download">
            Download
          </ButtonLink>
        </div>
      )}
    </Dialog>
  );
}

export function DraftStrip({ files, limit, notes, onRemove, onDismiss }: { files: DraftFile[]; limit: number | null; notes: Refusal[]; onRemove: (id: string) => void; onDismiss: (at: number) => void }) {
  return (
    <div className="chat-files" data-testid="draft-strip">
      {files.length > 0 && (
        <p className="font-mono text-label text-ink" data-testid="draft-total">
          {totalText(files.length, files.reduce((sum, { file }) => sum + file.size, 0), limit)}
        </p>
      )}
      {files.length > 0 && (
        <ul aria-label="Files to send" className="chat-file-list" data-testid="draft-list">
          {files.map(({ id, file, url }) => (
            <li key={id} className="chat-file" data-testid="draft-file">
              {kindOf(file) === "image" ? (
                <img src={url} alt="" decoding="sync" className="chat-file-thumb" />
              ) : (
                <span aria-hidden="true" className="chat-file-thumb chat-file-kind">
                  {kindTile(file.name)}
                </span>
              )}
              <span className="grid min-w-0">
                <span className="truncate text-meta font-strong" title={file.name}>
                  {shortName(file.name)}
                </span>
                <span className="font-mono text-label text-ink-2">{sizeToTenth(file.size)}, ready</span>
              </span>
              <button type="button" aria-label={"Remove " + file.name} title={"Remove " + file.name} onClick={() => onRemove(id)} className="chat-file-key" data-remove={id}>
                <Icon name="x" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <div role="alert" data-testid="draft-notes">
          <ul className="grid gap-s1">
            {notes.map((note, at) => (
              <li key={refusalText(note)} className="chat-file-note" data-testid="draft-note">
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {note.name !== null && <b className="font-strong text-stop">{notAdded(note.name)}</b>}
                  {note.name !== null && " "}
                  {note.why}
                </p>
                <button type="button" aria-label="Dismiss this note" title="Dismiss this note" onClick={() => onDismiss(at)} className="chat-file-key">
                  <Icon name="x" size="sm" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
