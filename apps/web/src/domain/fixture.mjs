export function card(fields) {
  return {
    version: 1,
    title: fields.id,
    priority: "P2",
    owner: "Alba",
    projectId: "quarterdeck",
    laneId: "l-sea",
    addedAt: "2026-11-01T09:00:00-05:00",
    due: null,
    about: null,
    description: null,
    ascii: null,
    skip: null,
    options: [],
    pickWhy: null,
    approvalDoor: "two-way",
    unblocks: [],
    labels: [],
    evidence: [],
    media: [],
    commands: [],
    changes: [],
    versions: [],
    seenAt: null,
    answer: null,
    more: { context: [], words: [], learn: [], note: null },
    ...fields,
  };
}

export function option(letter, label, fields = {}) {
  return { letter, label, pick: false, door: "two-way", pros: [], cons: [], ...fields };
}

export function task(id, title = id) {
  return { id, title, laneId: "l-sea", bot: "Alba", state: "Waiting on a Task Card" };
}
