import { avatarColor, avatarSlot } from "../domain/avatar";
import type { Bot, LaneStatus, Priority, Project } from "../domain/types";

export type ShortCard = {
  id: string;
  laneId: string;
  title: string;
  priority: Priority;
  ageDays: number;
  description: string;
  owner: string;
  kind: "options" | "action";
  options: string[];
  labels: { group: string; value: string }[];
  type: string;
  unblocks: string[];
  due: string | null;
  answer: { pick: string; at: string; note: string } | null;
  mailRef?: string;
};

export type LaneEntry = { id: string; projectId: string; name: string; status: LaneStatus };

export const EXAMPLE_NOW = "2026-11-02T10:00:00-05:00";

export const PROJECTS: Project[] = [
  { id: "quarterdeck", name: "quarterdeck", lead: "Alba", activeAt: "2026-11-02T09:48:00-05:00", description: "The Quarterdeck web app: Queue, Projects, Mail and Chat." },
  { id: "heron-forge", name: "heron-forge", lead: "Shelvorn", activeAt: "2026-11-02T08:00:00-05:00", description: "Matrix rooms and the bridge." },
  { id: "dale-tools", name: "dale-tools", lead: "Dr. Kivo", activeAt: "2026-11-01T10:00:00-05:00", description: "Small tools for the Dale bot." },
];

export const LANES: LaneEntry[] = [
  { id: "l-set", projectId: "quarterdeck", name: "Settings", status: "Active" },
  { id: "l-sea", projectId: "quarterdeck", name: "Search", status: "Active" },
  { id: "l-mai", projectId: "quarterdeck", name: "Mail client", status: "Active" },
  { id: "l-sid", projectId: "quarterdeck", name: "Sidebar and layout", status: "Done" },
  { id: "l-sw1", projectId: "heron-forge", name: "Matrix rooms", status: "Active" },
  { id: "l-sw2", projectId: "heron-forge", name: "Bridge", status: "Done" },
  { id: "l-da1", projectId: "dale-tools", name: "Task export", status: "Active" },
];

export const BOTS: Bot[] = [
  { id: "iris", name: "Iris", role: "Ops", color: avatarColor(1), pinned: true, order: 0 },
  { id: "alba", name: "Alba", role: "Project lead", color: avatarColor(2), pinned: true, order: 1 },
  { id: "dr-kivo", name: "Dr. Kivo", role: "Bot Manager", color: avatarColor(3), pinned: false, order: 2 },
  { id: "shelvorn", name: "Shelvorn", role: "Reviewer", color: avatarColor(4), pinned: false, order: 3 },
  { id: "dale", name: "Dale", role: "Tools", color: avatarColor(5), pinned: false, order: 4 },
  { id: "pib", name: "Pib", role: "Mail tester", color: avatarColor(avatarSlot("pib")), pinned: false, order: 5, removedAt: "2026-11-01T11:00:00-05:00" },
];

const settings = (kind: string) => [
  { group: "Kind", value: kind },
  { group: "Area", value: "Settings" },
];

export const SHORT_CARDS: ShortCard[] = [
  {
    id: "c1",
    laneId: "l-set",
    title: "Pick what a new device shows first",
    priority: "P1",
    ageDays: 2,
    description: "Choose the Appearance a new device starts with.",
    owner: "Alba",
    kind: "options",
    options: ["System", "Light", "Dark"],
    labels: settings("Decision"),
    type: "design",
    unblocks: ["t10", "t1"],
    due: "2026-11-03T17:00:00-05:00",
    answer: null,
  },
  {
    id: "c2",
    laneId: "l-set",
    title: "Approve the Settings sections",
    priority: "P0",
    ageDays: 1,
    description: "Bots, Appearance, Add-ons, Storage and Account at launch; Notifications later.",
    owner: "Shelvorn",
    kind: "action",
    options: [],
    labels: settings("Approval"),
    type: "approval",
    unblocks: ["t1", "t2"],
    due: "2026-11-02T18:00:00-05:00",
    answer: null,
    mailRef: "MT-103",
  },
  {
    id: "c4",
    laneId: "l-sea",
    title: "Search result grouping",
    priority: "P3",
    ageDays: 6,
    description: "Group results by Chats, Task Cards, Projects, Lanes, Mail.",
    owner: "Dr. Kivo",
    kind: "options",
    options: ["Keep 5 per group", "Show all"],
    labels: [
      { group: "Kind", value: "Decision" },
      { group: "Area", value: "Search" },
    ],
    type: "decision",
    unblocks: [],
    due: "2026-11-06T12:00:00-05:00",
    answer: null,
  },
  {
    id: "c6",
    laneId: "l-sw1",
    title: "Room list placeholder",
    priority: "P1",
    ageDays: 3,
    description: "Example only.",
    owner: "Shelvorn",
    kind: "action",
    options: [],
    labels: [{ group: "Kind", value: "Approval" }],
    type: "approval",
    unblocks: ["t6"],
    due: "2026-11-04T12:00:00-05:00",
    answer: null,
  },
  {
    id: "c9",
    laneId: "l-da1",
    title: "CSV export columns",
    priority: "P3",
    ageDays: 7,
    description: "Example only.",
    owner: "Iris",
    kind: "action",
    options: [],
    labels: [{ group: "Kind", value: "Approval" }],
    type: "approval",
    unblocks: ["t8"],
    due: "2026-11-09T12:00:00-05:00",
    answer: null,
  },
  {
    id: "c10",
    laneId: "l-set",
    title: "Which Appearance choices ship at launch?",
    priority: "P2",
    ageDays: 1,
    description: "Choose which Appearance choices ship at launch.",
    owner: "Alba",
    kind: "options",
    options: ["System and Dark", "System, Light and Dark"],
    labels: settings("Decision"),
    type: "decision",
    unblocks: [],
    due: null,
    answer: { pick: "System, Light and Dark", at: "2026-11-01T21:10:00-05:00", note: "Light is in now." },
  },
];

export const ANSWERED_EXTRA: ShortCard = {
  id: "c11",
  laneId: "l-sw1",
  title: "Which rooms move first?",
  priority: "P0",
  ageDays: 2,
  description: "Old rooms first, or the busiest rooms first.",
  owner: "Shelvorn",
  kind: "options",
  options: ["Old rooms first", "Busiest rooms first"],
  labels: [{ group: "Kind", value: "Decision" }],
  type: "decision",
  unblocks: [],
  due: null,
  answer: { pick: "Old rooms first", at: "2026-11-01T23:30:00-05:00", note: "" },
};
