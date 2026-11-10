import { createContext, useContext, useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { readAttachedText } from "../../data/attachment-text";
import type { Attachment } from "../../data/chat-types";
import type { DraftFile } from "../../data/session";
import { canRead, kindOf, sizeText } from "../../domain/chat-files";
import { blockedText } from "../../domain/files-r1";
import { outsideLink } from "../../platform/open-link";
import { ButtonLink, LinkButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";
import { Dialog, DialogHead } from "../../ui/overlay";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";

type Open = (file: Attachment, from: HTMLElement) => void;

const SERVER_ROW = "flex min-h-11 w-[min(100%,320px)] min-w-0 items-center gap-2.5 rounded-small border border-line-2 bg-panel px-3 py-2 text-left";

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
    <div className="flex min-h-28 w-28 flex-col justify-between gap-1 rounded-small border border-line-2 bg-raised p-2" data-testid="chat-picture-failed">
      <span className="text-small font-medium [overflow-wrap:anywhere]">{name}</span>
      <span className="text-small text-ink-3">This picture did not load.</span>
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
    <button type="button" onClick={(event) => onOpen(picture, event.currentTarget)} aria-label={"Open " + (picture.alt ?? picture.name)} className="flex-none cursor-pointer rounded-small" data-testid="chat-picture-open">
      <img key={tries} src={picture.url} alt={picture.alt ?? picture.name} decoding="sync" onError={() => setFailed(true)} className="size-28 rounded-small border border-line-2 object-cover" data-testid="chat-picture" />
    </button>
  );
}

function ServerPhoto({ picture, onOpen }: { picture: Attachment; onOpen: Open }) {
  const turn = useContext(PhotoTurn);
  const state = useSyncExternalStore(hearSettled, () => settled.get(picture.id) ?? null);
  if (state === "failed") return <FailedTile name={picture.name} onRetry={() => settle(picture.id, null)} />;
  if (state === null && turn !== picture.id) return <div role="img" aria-label={picture.alt ?? picture.name} className="size-28 flex-none rounded-small border border-line-2 bg-raised" data-testid="chat-picture-wait" />;
  return (
    <button type="button" onClick={(event) => onOpen(picture, event.currentTarget)} aria-label={"Open " + (picture.alt ?? picture.name)} className="flex-none cursor-pointer rounded-small" data-testid="chat-picture-open">
      <img src={picture.url} alt={picture.alt ?? picture.name} decoding="sync" onLoad={() => settle(picture.id, "loaded")} onError={() => settle(picture.id, "failed")} className="size-28 rounded-small border border-line-2 object-cover" data-testid="chat-picture" />
    </button>
  );
}

export function AttachmentList({ items, align, onOpen }: { items: Attachment[]; align: "start" | "end"; onOpen: Open }) {
  const pictures = items.filter(isPicture);
  const files = items.filter((item) => !isPicture(item));
  return (
    <div className={cx("grid max-w-full gap-2", align === "end" ? "justify-items-end" : "justify-items-start")} data-testid="chat-attachments">
      {pictures.length > 0 && (
        <div className={cx("flex flex-wrap gap-2", align === "end" && "justify-end")}>
          {pictures.map((picture) => (picture.kind ? <ServerPhoto key={picture.id} picture={picture} onOpen={onOpen} /> : <PictureTile key={picture.id} picture={picture} onOpen={onOpen} />))}
        </div>
      )}
      {files.map((file) =>
        file.kind === "blocked" ? (
          <p key={file.id} className={cx(SERVER_ROW, "text-ink-2")} data-testid="chat-file-blocked">
            <span className="flex min-w-0 flex-1 items-start gap-2.5 text-prose">
              <span className="flex h-[1lh] flex-none items-center">
                <Icon name="alert" size="sm" className="text-ink-3" />
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{blockedText(file.name)}</span>
            </span>
          </p>
        ) : file.kind === "file" ? (
          <a key={file.id} {...outsideLink(file.url)} className={cx(SERVER_ROW, "cursor-pointer hover:border-line-3")} data-testid="chat-file">
            <Icon name="file" size="sm" className="flex-none text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-prose" data-truncates="">{file.name}</span>
            <span className="flex-none text-small text-ink-3">{sizeText(file.size)}</span>
          </a>
        ) : (
          <button
            key={file.id}
            type="button"
            onClick={(event) => onOpen(file, event.currentTarget)}
            className="flex min-h-11 w-[min(100%,320px)] cursor-pointer items-center gap-2.5 rounded-small border border-line-2 bg-panel px-3 py-2 text-left hover:border-line-3"
            data-testid="chat-file"
          >
            <Icon name="file" size="sm" className="text-ink-3" />
            <span className="min-w-0 flex-1 text-prose [overflow-wrap:anywhere]">{file.name}</span>
            <span className="flex-none text-small text-ink-3">{sizeText(file.size)}</span>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-3 flex items-center gap-1.5 text-small text-ink-2">
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
            <pre tabIndex={0} className="m-0 overflow-x-auto rounded-small border border-line-2 bg-side px-3.5 py-3 font-mono text-code leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere] text-code-ink" data-testid="file-text">
              {text}
            </pre>
            {cut && (
              <p className="mt-2 text-small text-ink-2" data-testid="file-cut">
                Showing the first part only. Download for the whole file.
              </p>
            )}
          </>
        )}
      </div>
      {file.url && (
        <div className="flex-none border-t border-line p-3">
          <ButtonLink href={file.url} download={file.name} block data-testid="file-download">
            Download
          </ButtonLink>
        </div>
      )}
    </Dialog>
  );
}

export function DraftStrip({ files, onRemove }: { files: DraftFile[]; onRemove: (id: string) => void }) {
  return (
    <ul aria-label="Files to send" className="flex flex-wrap gap-2 px-3 pt-3" data-testid="draft-strip">
      {files.map(({ id, file, url }) => (
        <li key={id} className="relative flex-none" data-testid="draft-file">
          {kindOf(file) === "image" ? (
            <img src={url} alt={file.name} decoding="sync" className="size-[88px] rounded-small border border-line-2 object-cover" />
          ) : (
            <div className="flex min-h-[88px] w-44 max-w-full flex-col justify-end gap-0.5 rounded-small border border-line-2 bg-raised p-2.5">
              <Icon name="file" size="sm" className="mb-auto text-ink-3" />
              <span className="text-small [overflow-wrap:anywhere]">{file.name}</span>
              <span className="text-small text-ink-3">{sizeText(file.size)}</span>
            </div>
          )}
          <button type="button" aria-label={"Remove " + file.name} onClick={() => onRemove(id)} className="absolute top-0 right-0 grid size-11 cursor-pointer place-items-center" data-remove={id}>
            <span className="grid size-6 place-items-center rounded-full border border-line-3 bg-page text-ink">
              <Icon name="x" size="xs" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
