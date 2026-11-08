import { useEffect, useState, type RefObject } from "react";
import { readAttachedText } from "../../data/attachment-text";
import type { Attachment } from "../../data/chat-types";
import type { DraftFile } from "../../data/session";
import { canRead, kindOf, sizeText } from "../../domain/chat-files";
import { ButtonLink, LinkButton } from "../../ui/button";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/icon";
import { Dialog, DialogHead } from "../../ui/overlay";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";

type Open = (file: Attachment, from: HTMLElement) => void;

function PictureTile({ picture, onOpen }: { picture: Attachment; onOpen: Open }) {
  const [failed, setFailed] = useState(() => !picture.url);
  const [tries, setTries] = useState(0);
  if (failed)
    return (
      <div className="flex min-h-28 w-28 flex-col justify-between gap-1 rounded-small border border-line-2 bg-raised p-2" data-testid="chat-picture-failed">
        <span className="text-small font-medium [overflow-wrap:anywhere]">{picture.name}</span>
        <span className="text-small text-ink-3">This picture did not load.</span>
        {picture.url && (
          <LinkButton
            onClick={() => {
              setFailed(false);
              setTries(tries + 1);
            }}
          >
            Try again
          </LinkButton>
        )}
      </div>
    );
  return (
    <button type="button" onClick={(event) => onOpen(picture, event.currentTarget)} aria-label={"Open " + (picture.alt ?? picture.name)} className="flex-none cursor-pointer rounded-small" data-testid="chat-picture-open">
      <img key={tries} src={picture.url} alt={picture.alt ?? picture.name} decoding="sync" onError={() => setFailed(true)} className="size-28 rounded-small border border-line-2 object-cover" data-testid="chat-picture" />
    </button>
  );
}

export function AttachmentList({ items, align, onOpen }: { items: Attachment[]; align: "start" | "end"; onOpen: Open }) {
  const pictures = items.filter((item) => kindOf(item) === "image");
  const files = items.filter((item) => kindOf(item) === "file");
  return (
    <div className={cx("grid max-w-full gap-2", align === "end" ? "justify-items-end" : "justify-items-start")} data-testid="chat-attachments">
      {pictures.length > 0 && (
        <div className={cx("flex flex-wrap gap-2", align === "end" && "justify-end")}>
          {pictures.map((picture) => (
            <PictureTile key={picture.id} picture={picture} onOpen={onOpen} />
          ))}
        </div>
      )}
      {files.map((file) => (
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
      ))}
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
