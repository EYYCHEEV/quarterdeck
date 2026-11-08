import type { Tracker } from "../domain/tracker";
import type { World } from "../domain/types";

const EARLIER = [
  "Checked empty Search groups.",
  "Checked the recent-search list.",
  "Checked Search with the keyboard open.",
  "Kept the selected result in view.",
  "Checked the focus ring in the light look.",
  "Checked the focus ring in the dark look.",
  "Checked project names in Search.",
  "Checked Lane names in Search.",
  "Checked Mail references in Search.",
  "Checked Page references in Search.",
  "Checked Artifact references in Search.",
  "Kept result rows still while typing.",
  "Checked clearing the Search field.",
  "Checked opening a result on the phone.",
  "Checked returning from a Search result.",
  "Checked the Search loading state.",
  "Checked the Search error state.",
  "Checked Search after a retry."
];

export function laneStateWorld(world: World): World {
  return {
    ...world,
    cards: world.cards.map((card) => card.id === "c4" && !card.answer ? { ...card, answer: { choice: { kind: "option", letter: "A" }, at: "2026-11-01T16:00:00-05:00", note: "Keep five rows per group.", version: card.version, waitingOn: null, outcome: null } } : card),
    lanes: world.lanes.map((lane) => lane.id !== "l-sea" ? lane : {
      ...lane,
      activity: [...lane.activity, ...EARLIER.map((text, index) => ({ at: new Date(Date.parse("2026-10-30T12:00:00-04:00") - index * 60_000).toISOString(), bot: lane.lead, text, refs: [] }))]
    })
  };
}

export function laneStateTrackers(trackers: Record<string, Tracker>): Record<string, Tracker> {
  const search = trackers["l-sea"];
  return {
    ...trackers,
    "l-sea": {
      ...search,
      blockers: [...search.blockers, { what: "Search index export", waitingOn: "Alba", onYou: false, since: search.updated.at, taskCard: null, signOff: false }]
    }
  };
}
