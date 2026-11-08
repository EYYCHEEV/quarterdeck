export type Priority = "P0" | "P1" | "P2" | "P3" | "P4";

export type Door = "one-way" | "two-way";

export type CardOption = {
  letter: string;
  label: string;
  pick: boolean;
  door: Door;
  does?: string;
  cost?: string;
  risk?: string;
  undo?: string;
  pros: string[];
  cons: string[];
  tradeoff?: string;
  why?: string;
};

export type ChangeRecord = { by: string; at: string; following: string | null; followingAt?: string | null; what: string };

export type Closure = { id: string; by: string; at: string; following: string | null; followingAt: string | null };

export type VersionAnswer = { letter: string; label: string; note: string; at: string };

export type VersionRecord = {
  version: number;
  by: string;
  at: string;
  following: string | null;
  change: string | null;
  title: string;
  about: string | null;
  ascii: string | null;
  options: CardOption[];
  pickWhy: string | null;
  answer: VersionAnswer | null;
};

export type Choice = { kind: "option"; letter: string } | { kind: "none" } | { kind: "cant-decide" } | { kind: "approve" } | { kind: "reject" };

export type Outcome = { by: string; at: string; text: string };

export type Answer = { choice: Choice; at: string; note: string; version: number; waitingOn: string | null; outcome: Outcome | null; stale?: boolean };

export type Media = { kind: string; file: string; caption: string };

export type Command = { where: string; run: string };

export type EvidenceMedia = {
  id: string;
  kind: "image" | "video";
  role: "build" | "target" | "image";
  src: string;
  caption: string;
  by: string;
  at: string;
  target: string | null;
  poster: string | null;
  length: string | null;
  type: string | null;
};

export type EvidenceLink = {
  id: string;
  kind: "preview" | "live";
  title: string;
  url: string;
  shot: string;
  at: string;
  gated: boolean;
  status: "up" | "down" | null;
  downSince: string | null;
};

export type EvidenceCheck = { by: string; checks: { name: string; passed: boolean }[] };

export type CardEvidence = { doneBy: string; pageRef: string | null; media: EvidenceMedia[]; links: EvidenceLink[]; check: EvidenceCheck | null };

export type CardMore = {
  context: string[];
  words: [string, string][];
  learn: { label: string; url: string }[];
  note: string | null;
};

export type Card = {
  id: string;
  version: number;
  title: string;
  priority: Priority | "";
  owner: string;
  projectId: string;
  laneId: string;
  addedAt: string;
  due: string | null;
  about: string | null;
  description: string | null;
  ascii: string | null;
  skip: string | null;
  options: CardOption[];
  pickWhy: string | null;
  approvalDoor: Door;
  approvalUndo?: string | null;
  unblocks: string[];
  labels: string[];
  evidence: string[];
  media: Media[];
  commands: Command[];
  changes: ChangeRecord[];
  versions: VersionRecord[];
  seenAt: string | null;
  answer: Answer | null;
  more: CardMore;
};

export type Task = { id: string; title: string; laneId: string; bot: string; state: string };

export type Project = { id: string; name: string; lead: string; description: string; activeAt: string };

export type LaneStatus = "Active" | "Done";

export type Activity = { at: string; bot: string; text: string; refs: string[] };

export type Lane = { id: string; projectId: string; name: string; status: LaneStatus; lead: string; now: string; activity: Activity[]; lastLooked: string | null };

export type PageVersion = { n: number; madeAt: string; madeBy: string; file: string | null; kept: boolean };

export type PublicPage = { version: number; madeBy: string; madeAt: string; link: string; removal: "none" | "pending" };

export type PageReading = { version: number; at: string };

export type Page = {
  ref: string;
  projectId: string;
  title: string;
  by: string;
  updatedAt: string;
  live: boolean;
  file: string | null;
  laneId: string | null;
  pinned: boolean;
  current: number;
  versions: PageVersion[];
  public: PublicPage | null;
  reading: PageReading | null;
};

export type Artifact = {
  ref: string;
  name: string;
  kind: string;
  projectId: string;
  by: string;
  addedAt: string;
  size: string;
  laneIds: string[];
  cardIds: string[];
  storage: string;
  text: string;
};

export type ForwardedBy = { by: string; to: string[]; thread: string; mail: string };

export type Mail = { ref: string; from: string; to: string[]; cc: string[]; at: string; text: string; refs: string[]; forwardedFrom?: { ref: string }; forwardedBy?: ForwardedBy[] };

export type MailSummary = { lastAt: string; bots: string[]; days: string[]; count: number };

export type MailThread = { ref: string; subject: string; projectId: string; laneId: string | null; cardId: string | null; bots: string[]; mails: Mail[]; summary?: MailSummary; omitted?: number };

export type Bot = { id: string; name: string; role: string; color: string; pinned: boolean; order: number; removedAt?: string };

export type World = {
  cards: Card[];
  tasks: Task[];
  projects: Project[];
  lanes: Lane[];
  pages: Page[];
  artifacts: Artifact[];
  mail: MailThread[];
  bots: Bot[];
  closed?: Closure[];
};
