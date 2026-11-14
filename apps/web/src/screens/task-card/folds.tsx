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
    <div className="mt-s3">
      <Eyebrow className="mb-s1">{title}</Eyebrow>
      {children}
    </div>
  );
}

function More({ card, unblocks }: { card: Card; unblocks: string[] }) {
  const { context, words, learn, note } = card.more;
  return (
    <div className="grid gap-s1 pb-s2 pl-s4 text-body">
      {context.length > 0 && (
        <Part title="Context">
          <ul className="grid list-disc gap-s1 pl-s4 marker:text-ink-3">
            {context.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Part>
      )}
      {unblocks.length > 0 && (
        <Part title="Unblocks">
          <ul className="grid list-disc gap-s1 pl-s4 marker:text-ink-3">
            {unblocks.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </Part>
      )}
      {words.length > 0 && (
        <Part title="Words">
          <dl className="m-0 grid gap-s1">
            {words.map(([term, meaning]) => (
              <div key={term} className="flex flex-wrap gap-x-s2 text-body">
                <dt className="font-strong">{term}</dt>
                <dd className="m-0 text-ink-2">{meaning}</dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
      {learn.length > 0 && (
        <Part title="Links">
          <BotLinkConfirmation botName={card.owner}>
            {(confirm) => <ul className="grid gap-s1">
              {learn.map((link) => {
                const address = webAddress(link.url);
                const face = <>
                  <span className={address ? "text-inherit underline decoration-current underline-offset-3" : "text-ink-2"}>{link.label}</span>
                  <span className="break-all text-label text-ink-2">{address?.host ?? BLOCKED_LINK}</span>
                </>;
                return (
                  <li key={link.url}>
                    {address ? (
                      <BotLink url={address.href} confirm={confirm} className="grid min-h-hit max-w-full content-center" testId="learn-link">
                        {face}
                        <span className="sr-only">(asks before opening in a new tab)</span>
                      </BotLink>
                    ) : (
                      <div className="grid min-h-hit content-center" data-testid="learn-blocked">{face}</div>
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
          <div className="flex flex-wrap gap-s1">
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
    <li className="rounded-key border border-line bg-page px-s3 py-s2 text-body" data-testid="version">
      <p className="font-strong">
        Version {record.version} <span className="font-regular text-ink-2">· {record.by} · {whenText(record.at, now)}</span>
      </p>
      {record.following && <p className="text-new">Following your message: {record.following}</p>}
      {record.change && <p className="text-ink-2">{record.change}</p>}
      <p className="mt-s1 font-strong [overflow-wrap:anywhere]">{record.title}</p>
      {record.about && <p className="text-ink-2">{record.about}</p>}
      {record.ascii && <pre className="m-0 -mx-s1 mt-s2 overflow-hidden rounded-key border border-line bg-well px-s1 py-s2 font-mono text-label whitespace-pre text-ink" data-testid="version-picture">{record.ascii}</pre>}
      {record.options.length > 0 && (
        <ul className="mt-s2 grid gap-hair">
          {record.options.map((option) => (
            <li key={option.letter}>
              {option.letter}. {option.label}
              {option.pick && <span className="text-ink-2"> (their pick)</span>}
            </li>
          ))}
        </ul>
      )}
      {record.pickWhy && <p className="mt-s1 text-ink-2">Why: {record.pickWhy}</p>}
      {pick?.risk && <p className="mt-s1 text-ink-2">Risk: {pick.risk}</p>}
      {record.answer && (
        <p className="mt-s1 text-moving">
          You answered: {record.answer.letter}. {record.answer.label} · {whenText(record.answer.at, now)}
          {record.answer.note && <span className="text-ink-2"> · note: {record.answer.note}</span>}
        </p>
      )}
    </li>
  );
}

function Versions({ card, now }: { card: Card; now: number }) {
  return (
    <div className="pb-s2 upright:pl-s4">
      <Part title="Earlier versions">
        {card.versions.length ? (
          <ol className="grid grid-cols-1 gap-s2">
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
          <ol className="grid gap-s2 text-body">
            {[...card.changes].reverse().map((change) => (
              <li key={change.at + change.what} data-testid="change">
                <span className="font-strong">{change.by}</span>
                <span className="text-ink-2"> · {whenText(change.at, now)}: </span>
                {change.what}
                {change.following && <span className="block text-new">Following your message: {change.following}</span>}
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
    <div className="mt-s5 grid grid-cols-1">
      <div ref={more}>
        <Fold label="More: words, links, full notes, labels" open={whole || moreAsked > 0} request={moreAsked} testId="more">
          <More card={card} unblocks={unblocks} />
        </Fold>
      </div>
      <div ref={versions} className="scroll-mt-[80px]">
        <Fold label={versionsFold(card)} open={whole || versionsAsked > 0} request={versionsAsked} tone="changed" testId="earlier-versions">
          <Versions card={card} now={now} />
        </Fold>
      </div>
    </div>
  );
}
