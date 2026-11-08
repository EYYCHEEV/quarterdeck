import type { CardFields, CardThread, CardV1, CommentV1, ThreadComment } from "./card";

export const CARD_EXAMPLE_NOW = "2026-11-02T10:00:00-05:00";

const card = (fields: CardFields): CardV1 => ({ qd: "card/1", card: fields.id, ...fields });

const comment = (cardId: string, from: string, at: string, fields: Omit<CommentV1, "qd" | "card">): ThreadComment => ({
  from,
  at,
  body: { qd: "comment/1", card: cardId, ...fields },
});

function groupLimitCard(): CardThread {
  return {
    card: card({
      id: "alba-1",
      project: "quarterdeck",
      lane: "Search",
      title: "How many results should each Search group show?",
      about: "Rows per Search group before See all.",
      context: "",
      options: [{ label: "A. Show 5 per group", pick: true }, { label: "B. Show all results" }, { label: "C. Show 3 on a phone, 5 on a Mac" }],
      due: "2026-11-04T17:00:00-05:00",
      door: "two-way",
      category: ["strategy"],
      kind: "decision",
    }),
    rev: 1,
    from: "alba",
    at: "2026-11-02T08:30:00-05:00",
    priority: "P1",
    type: "strategy",
    unblocks: ["c4", "t3", "t4"],
    comments: [
      comment("alba-1", "dr-kivo", "2026-11-02T09:05:00-05:00", {
        text: "Five fits the iPhone screen with room for the keyboard.\nI tried it on the example data.",
      }),
      comment("alba-1", "Captain", "2026-11-02T09:20:00-05:00", { text: "Can the phone show 4?" }),
    ],
    answers: [],
  };
}

function roomCheckCard(): CardThread {
  return {
    card: card({
      id: "shelvorn-1",
      project: "heron-forge",
      lane: "Matrix rooms",
      title: "Run the room list check before the bridge change?",
      about: "A read-only list of rooms that will move.",
      context: "",
      options: [{ label: "A. Run the check now", pick: true }, { label: "B. Skip the check" }],
      due: "2026-11-03T12:00:00-05:00",
      door: "two-way",
      category: ["your-hands"],
      kind: "action",
    }),
    rev: 1,
    from: "shelvorn",
    at: "2026-11-02T08:45:00-05:00",
    priority: "P0",
    type: "high-risk approval",
    unblocks: ["t5", "t6", "t7", "c7"],
    comments: [],
    answers: [],
  };
}

function exportColumnsCard(): CardThread {
  return {
    card: card({
      id: "dr-kivo-1",
      project: "dale-tools",
      lane: "Task export",
      title: "Which columns should the Task Card export have?",
      about: "The export sheet's columns, in order.",
      context: "",
      options: [{ label: "A. Title, Lane, Owner, State", pick: true }, { label: "B. Title, Lane, State" }],
      due: "2026-11-05T17:00:00-05:00",
      door: "two-way",
      category: ["design"],
      kind: "decision",
    }),
    rev: 1,
    from: "dr-kivo",
    at: "2026-11-02T09:00:00-05:00",
    priority: "P2",
    type: "design",
    unblocks: ["c9", "t8", "t9"],
    comments: [
      comment("dr-kivo-1", "alba", "2026-11-02T09:30:00-05:00", {
        id: "col-name",
        text: "Three ways to name the first column. Pick one.",
        options: [{ label: "A. Task Card title", pick: true }, { label: "B. Short title" }, { label: "C. Title and Lane" }],
        pick_why: "The full title matches what the Captain sees on the card.",
      }),
    ],
    answers: [],
  };
}

function bridgeRetryCard(): CardThread {
  return {
    card: card({
      id: "shelvorn-2",
      project: "heron-forge",
      lane: "Bridge",
      title: "Should the bridge retry a failed message?",
      about: "Retry a failed bridge message, or stop?",
      context: "",
      options: [{ label: "A. Retry three times", pick: true }, { label: "B. Stop at once" }],
      due: "2026-11-03T17:00:00-05:00",
      door: "two-way",
      category: ["strategy"],
      kind: "decision",
    }),
    rev: 2,
    from: "shelvorn",
    at: "2026-11-01T16:00:00-05:00",
    priority: "P1",
    type: "strategy",
    unblocks: ["t5"],
    comments: [
      comment("shelvorn-2", "alba", "2026-11-02T07:30:00-05:00", {
        id: "retry-count",
        text: "If you want retries, how many?",
        options: [{ label: "A. Three tries", pick: true }, { label: "B. Five tries" }],
        pick_why: "Three tries cover a short outage without sending many copies.",
      }),
    ],
    answers: [
      { qd: "answer/1", card: "shelvorn-2", rev: 1, pick: "B", note: "Keep it simple for now.", at: "2026-11-02T07:50:00-05:00" },
      { qd: "answer/1", card: "shelvorn-2", comment: "retry-count", rev: 2, pick: "A", at: "2026-11-02T08:05:00-05:00" },
    ],
  };
}

export function exampleCardThreads(): CardThread[] {
  return [groupLimitCard(), roomCheckCard(), exportColumnsCard(), bridgeRetryCard()];
}
