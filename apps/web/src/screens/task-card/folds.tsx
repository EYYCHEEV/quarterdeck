import { useEffect, useRef, type ReactNode } from "react";
import { versionsFold } from "../../domain/card";
import { BLOCKED_LINK, webAddress } from "../../domain/external-link";
import { parseMarkdown } from "../../domain/markdown";
import { whenText } from "../../domain/time";
import type { Card, VersionRecord } from "../../domain/types";
import { BotLink, BotLinkConfirmation } from "../../ui/bot-link";
import { Chip } from "../../ui/chip";
import { Fold } from "../../ui/fold";
import { Markdown } from "../../ui/markdown";
import { Eyebrow } from "../../ui/panel";

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <Eyebrow className="mb-1.5">{title}</Eyebrow>
      {children}
    </div>
  );
}

function More({ card, unblocks }: { card: Card; unblocks: string[] }) {
  const { context, words, learn, note } = card.more;
  return (
    <div className="grid gap-1 pb-2 pl-5 text-body">
      {context.length > 0 && (
        <Part title="Context">
          <ul className="grid list-disc gap-1.5 pl-5 marker:text-ink-3">
            {context.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Part>
      )}
      {unblocks.length > 0 && (
        <Part title="Unblocks">
          <ul className="grid list-disc gap-1.5 pl-5 marker:text-ink-3">
            {unblocks.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </Part>
      )}
      {words.length > 0 && (
        <Part title="Words">
          <dl className="m-0 grid gap-1.5">
            {words.map(([term, meaning]) => (
              <div key={term} className="flex flex-wrap gap-x-2 text-prose">
                <dt className="font-semibold">{term}</dt>
                <dd className="m-0 text-ink-2">{meaning}</dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
      {learn.length > 0 && (
        <Part title="Links">
          <BotLinkConfirmation botName={card.owner}>
            {(confirm) => <ul className="grid gap-1">
              {learn.map((link) => {
                const address = webAddress(link.url);
                const face = <>
                  <span className={address ? "text-link underline decoration-link/35 underline-offset-3" : "text-ink-2"}>{link.label}</span>
                  <span className="break-all text-xs text-ink-2">{address?.host ?? BLOCKED_LINK}</span>
                </>;
                return (
                  <li key={link.url}>
                    {address ? (
                      <BotLink url={address.href} confirm={confirm} className="grid min-h-11 max-w-full content-center" testId="learn-link">
                        {face}
                        <span className="sr-only">(asks before opening in a new tab)</span>
                      </BotLink>
                    ) : (
                      <div className="grid min-h-11 content-center" data-testid="learn-blocked">{face}</div>
                    )}
                  </li>
                );
              })}
            </ul>}
          </BotLinkConfirmation>
        </Part>
      )}
      {note && (
        <Part title={"Note from " + card.owner}>
          <Markdown blocks={parseMarkdown(note)} botName={card.owner} />
        </Part>
      )}
      <Part title="Labels">
        {card.labels.length ? (
          <div className="flex flex-wrap gap-1.5">
            {card.labels.map((label) => (
              <Chip key={label}>{label}</Chip>
            ))}
          </div>
        ) : (
          <p className="text-meta text-ink-2">No labels</p>
        )}
      </Part>
    </div>
  );
}

function Version({ record, now }: { record: VersionRecord; now: number }) {
  const pick = record.options.find((option) => option.pick);
  return (
    <li className="rounded-small border border-line bg-page px-3 py-2.5 text-note" data-testid="version">
      <p className="font-semibold">
        Version {record.version} <span className="font-normal text-ink-2">· {record.by} · {whenText(record.at, now)}</span>
      </p>
      {record.following && <p className="text-violet">Following your message: {record.following}</p>}
      {record.change && <p className="text-ink-2">{record.change}</p>}
      <p className="mt-1.5 font-semibold [overflow-wrap:anywhere]">{record.title}</p>
      {record.about && <p className="text-ink-2">{record.about}</p>}
      {record.ascii && <pre className="m-0 -mx-1.5 mt-2 overflow-hidden rounded-small border border-line bg-well px-1.5 py-2 font-mono text-picture whitespace-pre text-picture-ink" data-testid="version-picture">{record.ascii}</pre>}
      {record.options.length > 0 && (
        <ul className="mt-2 grid gap-0.5">
          {record.options.map((option) => (
            <li key={option.letter}>
              {option.letter}. {option.label}
              {option.pick && <span className="text-ink-2"> (their pick)</span>}
            </li>
          ))}
        </ul>
      )}
      {record.pickWhy && <p className="mt-1 text-ink-2">Why: {record.pickWhy}</p>}
      {pick?.risk && <p className="mt-1 text-ink-2">Risk: {pick.risk}</p>}
      {record.answer && (
        <p className="mt-1.5 text-green">
          You answered: {record.answer.letter}. {record.answer.label} · {whenText(record.answer.at, now)}
          {record.answer.note && <span className="text-ink-2"> · note: {record.answer.note}</span>}
        </p>
      )}
    </li>
  );
}

function Versions({ card, now }: { card: Card; now: number }) {
  return (
    <div className="pb-2 upright:pl-5">
      <Part title="Earlier versions">
        {card.versions.length ? (
          <ol className="grid grid-cols-1 gap-2">
            {[...card.versions].reverse().map((record) => (
              <Version key={record.version} record={record} now={now} />
            ))}
          </ol>
        ) : (
          <p className="text-meta text-ink-2">Earlier card content unavailable</p>
        )}
      </Part>
      <Part title="Change trail">
        {card.changes.length ? (
          <ol className="grid gap-2 text-note">
            {[...card.changes].reverse().map((change) => (
              <li key={change.at + change.what} data-testid="change">
                <span className="font-semibold">{change.by}</span>
                <span className="text-ink-2"> · {whenText(change.at, now)}: </span>
                {change.what}
                {change.following && <span className="block text-violet">Following your message: {change.following}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-meta text-ink-2">No changes</p>
        )}
      </Part>
    </div>
  );
}

export function Folds({ card, unblocks, whole, versionsAsked, moreAsked, now }: { card: Card; unblocks: string[]; whole: boolean; versionsAsked: number; moreAsked: number; now: number }) {
  const versions = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!versionsAsked) return;
    const frame = requestAnimationFrame(() => versions.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [versionsAsked]);
  useEffect(() => {
    if (!moreAsked) return;
    const frame = requestAnimationFrame(() => more.current?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [moreAsked]);
  return (
    <div className="mt-6 grid grid-cols-1">
      <div ref={more}>
        <Fold label="More: words, links, full notes, labels" open={whole || moreAsked > 0} request={moreAsked} testId="more">
          <More card={card} unblocks={unblocks} />
        </Fold>
      </div>
      <div ref={versions} className="scroll-mt-20">
        <Fold label={versionsFold(card)} open={whole || versionsAsked > 0} request={versionsAsked} tone="changed" testId="earlier-versions">
          <Versions card={card} now={now} />
        </Fold>
      </div>
    </div>
  );
}
