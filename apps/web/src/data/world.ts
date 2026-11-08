import type { Answer, Bot, Card, CardOption, ChangeRecord, Choice, Door, Lane, Outcome, Project, VersionRecord, World } from "../domain/types";
import type { AnswerV1, CardThread, Option } from "./card";
import { answeredOutcome as cardOutcomes, cards, currentFixes, versions } from "./card-content.json";
import { BOTS, EXAMPLE_NOW, LANES, PROJECTS, type ShortCard } from "./example-content";
import { answeredOutcome } from "./lanes-addendum.json";
import { exampleLanes } from "./lanes";
import { ARTIFACTS, cardEdits, MAIL_THREADS, PAGES, TASKS, type CardEdit, type MailThread, type PackArtifact } from "./pack-extra";
import { buildPages, type PageChange, type RawPage } from "./pages";

type RawOption = Omit<Option, "door"> & { door?: string };

type VersionEntry = {
  version: number;
  madeBy: string;
  madeAt: string;
  following: { text: string } | null;
  change: string | null;
  answer: { pick: string; note: string; at: string } | null;
  card: { title: string; about?: string; ascii?: string; options?: RawOption[]; pick_why?: string; door?: string };
};

export type Content = {
  cards: Record<string, { about?: string; ascii?: string }>;
  currentFixes: Record<string, { context: string }>;
  versions: Record<string, VersionEntry[]>;
  answeredOutcome: Record<string, Outcome>;
};

export type ThreadExtra = { laneId?: string; edits: CardEdit[]; seenAt: string | null; versions: VersionEntry[] };

export type Session = { seen: Map<string, string>; answers: Map<string, Answer>; looked: Map<string, string>; pages?: Map<string, PageChange> };

export type Sources = {
  threads: CardThread[];
  extras: Map<string, ThreadExtra>;
  short: ShortCard[];
  session: Session;
  pages: RawPage[];
  artifacts?: PackArtifact[];
  mail?: MailThread[];
  bots?: Bot[];
  added?: { projects: Project[]; lanes: Lane[] };
};

const CONTENT: Content = { cards, currentFixes, versions, answeredOutcome: { ...cardOutcomes, ...answeredOutcome } };
const LETTERS = "ABCDEFGH";
const DAY = 86_400_000;

const botName = (id: string) => BOTS.find((bot) => bot.id === id)?.name ?? id;
const distinct = (values: string[]) => values.filter((value, at) => values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === at);

const doorOf = (door: string | undefined): Door | undefined => (door === "one-way" || door === "two-way" ? door : undefined);

function optionsOf(options: RawOption[] | undefined, cardDoor: string | undefined): CardOption[] {
  return (options ?? []).map((option, at) => {
    const lettered = /^([A-Z])\.\s*(.*)$/.exec(option.label);
    const pick = option.pick === true;
    return {
      letter: lettered ? lettered[1] : LETTERS[at],
      label: lettered ? lettered[2] : option.label,
      pick,
      door: doorOf(option.door) ?? (pick ? doorOf(cardDoor) : undefined) ?? "two-way",
      does: option.does,
      cost: option.cost,
      risk: option.risk,
      undo: option.undo,
      pros: option.pros ?? [],
      cons: option.cons ?? [],
      tradeoff: option.tradeoff,
      why: option.why,
    };
  });
}

const changesOf = (edits: CardEdit[]): ChangeRecord[] => edits.map((edit) => ({ by: edit.by, at: edit.at, following: edit.instruction.text, followingAt: edit.instruction.at, what: edit.change }));

function versionsOf(entries: VersionEntry[]): VersionRecord[] {
  return entries.map((entry) => {
    const options = optionsOf(entry.card.options, entry.card.door);
    const answered = entry.answer;
    return {
      version: entry.version,
      by: entry.madeBy,
      at: entry.madeAt,
      following: entry.following?.text ?? null,
      change: entry.change,
      title: entry.card.title,
      about: entry.card.about ?? null,
      ascii: entry.card.ascii ?? null,
      options,
      pickWhy: entry.card.pick_why ?? null,
      answer: answered ? { letter: answered.pick, label: options.find((o) => o.letter === answered.pick)?.label ?? "", note: answered.note, at: answered.at } : null,
    };
  });
}

function wireAnswer(answer: AnswerV1, owner: string, id: string, content: Content): Answer {
  const choice: Choice = answer.pick === "none" ? { kind: "none" } : { kind: "option", letter: answer.pick };
  return { choice, at: answer.at, note: answer.note ?? "", version: answer.rev, waitingOn: choice.kind === "none" ? owner : null, outcome: content.answeredOutcome[id] ?? null };
}

function threadCard(thread: CardThread, extra: ThreadExtra, session: Session, content: Content): Card {
  const { card } = thread;
  const owner = botName(thread.from);
  const given = thread.answers.filter((answer) => answer.comment === undefined && answer.rev === thread.rev && answer.pick !== "cant-decide").at(-1);
  const laneId = extra.laneId ?? LANES.find((lane) => lane.projectId === card.project && lane.name === card.lane)?.id ?? "";
  return {
    id: card.id,
    version: thread.rev,
    title: card.title,
    priority: thread.priority ?? "P2",
    owner,
    projectId: card.project,
    laneId,
    addedAt: thread.at,
    due: card.due ?? null,
    about: card.about,
    description: null,
    ascii: card.ascii ?? content.cards[card.id]?.ascii ?? null,
    skip: card.skip ?? null,
    options: optionsOf(card.options, card.door),
    pickWhy: card.pick_why ?? null,
    approvalDoor: card.door ?? "two-way",
    approvalUndo: card.undo ?? null,
    unblocks: thread.unblocks ?? [],
    labels: distinct([thread.type ?? "", ...card.category].filter(Boolean)),
    evidence: [...(card.mailRef ? [card.mailRef] : []), ...(card.pageRefs ?? []), ...(card.artifactRefs ?? [])],
    media: card.media ?? [],
    commands: card.commands ?? [],
    changes: changesOf(extra.edits),
    versions: versionsOf(extra.versions),
    seenAt: session.seen.get(card.id) ?? extra.seenAt,
    answer: session.answers.get(card.id) ?? (given ? wireAnswer(given, owner, card.id, content) : null),
    more: {
      context: (content.currentFixes[card.id]?.context ?? card.context).split("\n").filter(Boolean),
      words: card.words ?? [],
      learn: card.learn ?? [],
      note: card.note ?? null,
    },
  };
}

function shortChoice(short: ShortCard, pick: string): Choice {
  if (pick === "Approve") return { kind: "approve" };
  if (pick === "Reject") return { kind: "reject" };
  return { kind: "option", letter: LETTERS[Math.max(0, short.options.indexOf(pick))] };
}

function shortCard(short: ShortCard, session: Session, content: Content): Card {
  const extra = content.cards[short.id];
  const edits = cardEdits(short.id);
  const stored = short.answer;
  return {
    id: short.id,
    version: 1,
    title: short.title,
    priority: short.priority,
    owner: short.owner,
    projectId: LANES.find((lane) => lane.id === short.laneId)?.projectId ?? "",
    laneId: short.laneId,
    addedAt: new Date(Date.parse(EXAMPLE_NOW) - short.ageDays * DAY).toISOString(),
    due: short.due,
    about: extra?.about ?? null,
    description: short.description,
    ascii: extra?.ascii ?? null,
    skip: null,
    options: short.options.map((label, at) => ({ letter: LETTERS[at], label, pick: false, door: "two-way", pros: [], cons: [] })),
    pickWhy: null,
    approvalDoor: "two-way",
    unblocks: short.unblocks,
    labels: distinct([short.type, ...short.labels.map((label) => label.value)]),
    evidence: short.mailRef ? [short.mailRef] : [],
    media: [],
    commands: [],
    changes: changesOf(edits.edits),
    versions: versionsOf(content.versions[short.id] ?? []),
    seenAt: session.seen.get(short.id) ?? edits.seenAt,
    answer:
      session.answers.get(short.id) ??
      (stored ? { choice: shortChoice(short, stored.pick), at: stored.at, note: stored.note, version: 1, waitingOn: null, outcome: content.answeredOutcome[short.id] ?? null } : null),
    more: { context: [], words: [], learn: [], note: null },
  };
}

function exampleExtra(id: string, content: Content): ThreadExtra {
  const edits = cardEdits(id);
  return { edits: edits.edits, seenAt: edits.seenAt, versions: content.versions[id] ?? [] };
}

export function buildCards(sources: Pick<Sources, "threads" | "extras" | "short" | "session">, content: Content): Card[] {
  return [
    ...sources.threads.map((thread) => threadCard(thread, sources.extras.get(thread.card.id) ?? exampleExtra(thread.card.id, content), sources.session, content)),
    ...sources.short.map((short) => shortCard(short, sources.session, content)),
  ];
}

export function buildWorld(sources: Sources): World {
  const { looked } = sources.session;
  return {
    cards: buildCards(sources, CONTENT),
    tasks: [...TASKS],
    projects: [...PROJECTS, ...(sources.added?.projects ?? [])],
    lanes: [...exampleLanes(), ...(sources.added?.lanes ?? [])].map((lane) => ({ ...lane, lastLooked: looked.get(lane.id) ?? lane.lastLooked })),
    pages: buildPages([...PAGES, ...sources.pages], sources.session.pages),
    artifacts: [...ARTIFACTS, ...(sources.artifacts ?? [])],
    mail: (sources.mail ?? MAIL_THREADS).map((thread) => ({ ...thread, mails: thread.mails.map((mail) => ({ ref: mail.ref, from: mail.from, to: mail.to, cc: mail.cc ?? [], at: mail.at, text: mail.text, refs: [...(mail.artifactRefs ?? []), ...(mail.pageRefs ?? [])], ...(mail.forwardedFrom ? { forwardedFrom: mail.forwardedFrom } : {}), ...(mail.forwardedBy ? { forwardedBy: mail.forwardedBy } : {}) })) })),
    bots: [...BOTS, ...(sources.bots ?? [])],
  };
}

