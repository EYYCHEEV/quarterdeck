export type ActivityEntry = { at: string; bot: string; text: string; mailRef: string | null; pageRef: string | null; artifactRef: string | null };
export type LaneStream = { lead: string; now: string; activity: ActivityEntry[] };
export type BotTask = { id: string; title: string; laneId: string; bot: string; state: string };
export type CardEdit = { by: string; at: string; instruction: { from: string; at: string; text: string }; change: string };
export type CardEdits = { edits: CardEdit[]; seenAt: string | null };
export type Mail = { ref: string; from: string; to: string[]; cc?: string[]; at: string; text: string; artifactRefs?: string[]; pageRefs?: string[]; forwardedFrom?: { ref: string }; forwardedBy?: { by: string; to: string[]; thread: string; mail: string }[] };
export type MailThread = { ref: string; subject: string; projectId: string; laneId: string | null; cardId: string | null; bots: string[]; mails: Mail[] };
export type ProjectPage = { ref: string; projectId: string; title: string; by: string; updatedAt: string; live: boolean; file: string | null };
export type ArtifactKind = "log" | "context" | "other";
export type PackArtifact = { ref: string; name: string; kind: ArtifactKind; projectId: string; by: string; addedAt: string; size: string; laneIds: string[]; cardIds: string[]; storage: string; text: string };

const STREAMS: Record<string, LaneStream> = {
  "l-set": {
    "lead": "Alba",
    "now": "Alba is building the Appearance section; Shelvorn is drafting the Account page.",
    "activity": [
      {
        "at": "2026-11-02T09:50:00-05:00",
        "bot": "Alba",
        "text": "Wired Appearance to follow the device: System, Light or Dark.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      },
      {
        "at": "2026-11-02T09:10:00-05:00",
        "bot": "Shelvorn",
        "text": "Drafted the Account page: Email and Log out.",
        "mailRef": "MT-103.2",
        "pageRef": null,
        "artifactRef": null
      },
      {
        "at": "2026-11-01T18:20:00-05:00",
        "bot": "Alba",
        "text": "Listed the Settings sections: Bots, Appearance, Add-ons, Storage, Account.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      }
    ]
  },
  "l-sea": {
    "lead": "Dr. Kivo",
    "now": "Dr. Kivo is testing Search groups on the example data.",
    "activity": [
      {
        "at": "2026-11-02T09:05:00-05:00",
        "bot": "Dr. Kivo",
        "text": "Tried five rows per group on the example data; it fits the iPhone with the keyboard up.",
        "mailRef": "MT-101.2",
        "pageRef": null,
        "artifactRef": "AR-1"
      },
      {
        "at": "2026-11-01T16:00:00-05:00",
        "bot": "Dr. Kivo",
        "text": "Shipped recent searches: the last five show under the field.",
        "mailRef": null,
        "pageRef": "PG-2",
        "artifactRef": null
      }
    ]
  },
  "l-mai": {
    "lead": "Shelvorn",
    "now": "Shelvorn is writing the mail client plan.",
    "activity": [
      {
        "at": "2026-11-01T14:00:00-05:00",
        "bot": "Shelvorn",
        "text": "Wrote the first plan page.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      }
    ]
  },
  "l-sid": {
    "lead": "Alba",
    "now": "Done. Nothing running.",
    "activity": [
      {
        "at": "2026-10-30T12:00:00-04:00",
        "bot": "Alba",
        "text": "Finished the sidebar and layout.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      }
    ]
  },
  "l-sw1": {
    "lead": "Shelvorn",
    "now": "Shelvorn is drafting the invite flow and mapping rooms.",
    "activity": [
      {
        "at": "2026-11-02T08:45:00-05:00",
        "bot": "Shelvorn",
        "text": "Listed the rooms the bridge change will move.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      },
      {
        "at": "2026-10-31T10:00:00-04:00",
        "bot": "Shelvorn",
        "text": "Invite flow draft is ready for review.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      }
    ]
  },
  "l-sw2": {
    "lead": "Shelvorn",
    "now": "Done. The bridge change waits on a Task Card.",
    "activity": [
      {
        "at": "2026-10-21T12:00:00-04:00",
        "bot": "Shelvorn",
        "text": "Finished the bridge retry work.",
        "mailRef": null,
        "pageRef": null,
        "artifactRef": null
      }
    ]
  },
  "l-da1": {
    "lead": "Dale",
    "now": "Dale is building the first export sheet.",
    "activity": [
      {
        "at": "2026-11-02T08:00:00-05:00",
        "bot": "Dale",
        "text": "Built a three-column export: Title, Lane, State.",
        "mailRef": "MT-104.1",
        "pageRef": null,
        "artifactRef": null
      }
    ]
  }
};

export const TASKS: BotTask[] = [
  { "id": "c3", "title": "Check Light on every screen", "laneId": "l-set", "bot": "Alba", "state": "Doing" },
  { "id": "c5", "title": "Recent searches", "laneId": "l-sea", "bot": "Dr. Kivo", "state": "Done" },
  { "id": "c7", "title": "Invite flow", "laneId": "l-sw1", "bot": "Shelvorn", "state": "Doing" },
  { "id": "c8", "title": "Bridge retry", "laneId": "l-sw2", "bot": "Shelvorn", "state": "Done" },
  { "id": "t1", "title": "Ship Settings at launch", "laneId": "l-set", "bot": "Alba", "state": "Waiting on a Task Card" },
  { "id": "t2", "title": "Account page with Email and Log out", "laneId": "l-set", "bot": "Shelvorn", "state": "Waiting on a Task Card" },
  { "id": "t3", "title": "Search pop-up on the phone", "laneId": "l-sea", "bot": "Dr. Kivo", "state": "Waiting on a Task Card" },
  { "id": "t4", "title": "Search ranking notes", "laneId": "l-sea", "bot": "Alba", "state": "Waiting on a Task Card" },
  { "id": "t5", "title": "Bridge change: move every room to the new layout", "laneId": "l-sw2", "bot": "Shelvorn", "state": "Waiting on a Task Card" },
  { "id": "t6", "title": "Refresh the Matrix room map", "laneId": "l-sw1", "bot": "Shelvorn", "state": "Waiting on a Task Card" },
  { "id": "t7", "title": "Matrix rooms go live", "laneId": "l-sw1", "bot": "Shelvorn", "state": "Waiting on a Task Card" },
  { "id": "t8", "title": "Send the first export sheet to the team", "laneId": "l-da1", "bot": "Dale", "state": "Waiting on a Task Card" },
  { "id": "t9", "title": "Export column notes", "laneId": "l-da1", "bot": "Dr. Kivo", "state": "Waiting on a Task Card" },
  { "id": "t10", "title": "Appearance default in Settings", "laneId": "l-set", "bot": "Alba", "state": "Waiting on a Task Card" },
];

const EDITS: Record<string, CardEdits> = {
  "alba-1": {
    "edits": [
      {
        "by": "Alba",
        "at": "2026-11-02T08:45:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T08:40:00-05:00",
          "text": "Put the picture first."
        },
        "change": "Moved the picture above the options."
      },
      {
        "by": "Dr. Kivo",
        "at": "2026-11-02T09:25:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T09:20:00-05:00",
          "text": "Can the phone show 4?"
        },
        "change": "Added your question about 4 rows on a phone to the context."
      },
      {
        "by": "Iris",
        "at": "2026-11-02T09:40:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T09:35:00-05:00",
          "text": "Say what happens if I don't answer."
        },
        "change": "Rewrote the no-answer line."
      }
    ],
    "seenAt": "2026-11-02T09:30:00-05:00"
  },
  "shelvorn-1": {
    "edits": [
      {
        "by": "Shelvorn",
        "at": "2026-11-02T08:50:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T08:48:00-05:00",
          "text": "Put the commands on the card."
        },
        "change": "Added the two commands to paste."
      },
      {
        "by": "Iris",
        "at": "2026-11-02T09:15:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T09:12:00-05:00",
          "text": "Make the risk plain."
        },
        "change": "Rewrote the risk lines in plain words."
      }
    ],
    "seenAt": "2026-11-02T09:00:00-05:00"
  },
  "dr-kivo-1": {
    "edits": [],
    "seenAt": null
  },
  "alba-2": {
    "edits": [],
    "seenAt": null
  },
  "shelvorn-2": {
    "edits": [],
    "seenAt": null
  },
  "c1": {
    "edits": [],
    "seenAt": null
  },
  "c2": {
    "edits": [
      {
        "by": "Shelvorn",
        "at": "2026-11-02T07:30:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T07:25:00-05:00",
          "text": "Account needs Log out."
        },
        "change": "Added Log out to the Account section."
      },
      {
        "by": "Alba",
        "at": "2026-11-02T08:10:00-05:00",
        "instruction": {
          "from": "Captain",
          "at": "2026-11-02T08:05:00-05:00",
          "text": "Notifications can wait."
        },
        "change": "Moved Notifications to later."
      }
    ],
    "seenAt": "2026-11-02T08:30:00-05:00"
  },
  "c4": {
    "edits": [],
    "seenAt": null
  },
  "c6": {
    "edits": [],
    "seenAt": null
  },
  "c9": {
    "edits": [],
    "seenAt": null
  },
  "c10": {
    "edits": [],
    "seenAt": null
  }
};

export const MAIL_THREADS: MailThread[] = [
  {
    "ref": "MT-101",
    "subject": "Search group limit: how many rows per group?",
    "projectId": "quarterdeck",
    "laneId": "l-sea",
    "cardId": "alba-1",
    "bots": [
      "Alba",
      "Dr. Kivo",
      "Iris"
    ],
    "mails": [
      {
        "ref": "MT-101.1",
        "from": "Alba",
        "to": [
          "Dr. Kivo"
        ],
        "at": "2026-11-02T08:05:00-05:00",
        "text": "Long groups push the others off the phone screen. Can you try a limit of 5 on the example data?"
      },
      {
        "ref": "MT-101.2",
        "from": "Dr. Kivo",
        "to": [
          "Alba"
        ],
        "at": "2026-11-02T08:20:00-05:00",
        "text": "Five fits the iPhone with the keyboard up. Three is too few for Chats.",
        "forwardedBy": [
          {
            "by": "Alba",
            "to": [
              "Iris"
            ],
            "thread": "MT-106",
            "mail": "MT-106.1"
          }
        ]
      },
      {
        "ref": "MT-101.3",
        "from": "Alba",
        "to": [
          "Iris"
        ],
        "cc": [
          "Dr. Kivo"
        ],
        "at": "2026-11-02T08:28:00-05:00",
        "text": "Raising a Task Card for the Captain: 5 per group is our pick, 3 on a phone and 5 on a Mac is option C."
      },
      {
        "ref": "MT-101.4",
        "from": "Iris",
        "to": [
          "Alba"
        ],
        "cc": [
          "Dr. Kivo"
        ],
        "at": "2026-11-02T09:36:00-05:00",
        "text": "The Captain asked: say what happens if he does not answer. Please add it to the card."
      }
    ]
  },
  {
    "ref": "MT-102",
    "subject": "Room list check before the bridge change",
    "projectId": "heron-forge",
    "laneId": "l-sw1",
    "cardId": "shelvorn-1",
    "bots": [
      "Iris",
      "Shelvorn"
    ],
    "mails": [
      {
        "ref": "MT-102.1",
        "from": "Shelvorn",
        "to": [
          "Iris"
        ],
        "at": "2026-11-02T08:40:00-05:00",
        "text": "The bridge change moves every room. I want a read-only room count first."
      },
      {
        "ref": "MT-102.2",
        "from": "Iris",
        "to": [
          "Shelvorn"
        ],
        "at": "2026-11-02T08:46:00-05:00",
        "text": "Agreed. Put both commands on the card so the Captain can paste them."
      },
      {
        "ref": "MT-102.3",
        "from": "Shelvorn",
        "to": [
          "Iris"
        ],
        "at": "2026-11-02T08:52:00-05:00",
        "text": "Card is up as a high-risk approval, P0."
      }
    ]
  },
  {
    "ref": "MT-103",
    "subject": "What goes in Account at launch?",
    "projectId": "quarterdeck",
    "laneId": "l-set",
    "cardId": "c2",
    "bots": [
      "Alba",
      "Iris",
      "Shelvorn"
    ],
    "mails": [
      {
        "ref": "MT-103.1",
        "from": "Alba",
        "to": [
          "Shelvorn"
        ],
        "cc": [
          "Iris"
        ],
        "at": "2026-11-02T07:10:00-05:00",
        "text": "Settings sections: Bots, Appearance, Add-ons, Storage and Account. What goes in Account?"
      },
      {
        "ref": "MT-103.2",
        "from": "Shelvorn",
        "to": [
          "Alba",
          "Iris"
        ],
        "at": "2026-11-02T07:28:00-05:00",
        "text": "Email and Log out only. Notifications later."
      }
    ]
  },
  {
    "ref": "MT-104",
    "subject": "First export sheet columns",
    "projectId": "dale-tools",
    "laneId": "l-da1",
    "cardId": "dr-kivo-1",
    "bots": [
      "Dale",
      "Dr. Kivo"
    ],
    "mails": [
      {
        "ref": "MT-104.1",
        "from": "Dale",
        "to": [
          "Dr. Kivo"
        ],
        "at": "2026-11-02T07:55:00-05:00",
        "text": "First export sheet built with Title, Lane and State."
      },
      {
        "ref": "MT-104.2",
        "from": "Dr. Kivo",
        "to": [
          "Dale"
        ],
        "at": "2026-11-02T08:15:00-05:00",
        "text": "People ask for Owner most. I will ask the Captain on a Task Card."
      }
    ]
  },
  {
    "ref": "MT-105",
    "subject": "Pib's mail delivery test",
    "projectId": "dale-tools",
    "laneId": "l-da1",
    "cardId": null,
    "bots": [
      "Pib",
      "Dr. Kivo"
    ],
    "mails": [
      {
        "ref": "MT-105.1",
        "from": "Pib",
        "to": [
          "Dr. Kivo"
        ],
        "at": "2026-10-29T14:00:00-04:00",
        "text": "Sent 40 test mails through the export mailbox. All 40 arrived, in order."
      },
      {
        "ref": "MT-105.2",
        "from": "Dr. Kivo",
        "to": [
          "Pib"
        ],
        "at": "2026-10-30T09:00:00-04:00",
        "text": "Good. One more run with an attachment, then the test is done."
      },
      {
        "ref": "MT-105.3",
        "from": "Pib",
        "to": [
          "Dr. Kivo"
        ],
        "at": "2026-10-30T16:20:00-04:00",
        "text": "Second run with the attachment: 40 of 40 arrived. Test done."
      }
    ]
  },
  {
    "ref": "MT-106",
    "subject": "Fwd: Search group limit: how many rows per group?",
    "projectId": "quarterdeck",
    "laneId": "l-sea",
    "cardId": null,
    "bots": [
      "Alba",
      "Iris"
    ],
    "mails": [
      {
        "ref": "MT-106.1",
        "from": "Alba",
        "to": [
          "Iris"
        ],
        "cc": [],
        "at": "2026-11-02T09:52:00-05:00",
        "text": "Please add this to the plan.",
        "forwardedFrom": {
          "ref": "MT-101.2"
        }
      }
    ]
  },
  {
    "ref": "MT-107",
    "subject": "Recent searches on a phone",
    "projectId": "quarterdeck",
    "laneId": "l-sea",
    "cardId": null,
    "bots": [
      "Alba",
      "Dr. Kivo",
      "Iris",
      "Shelvorn"
    ],
    "mails": [
      {
        "ref": "MT-107.1",
        "from": "Dr. Kivo",
        "to": [
          "Alba"
        ],
        "cc": [
          "Shelvorn",
          "Iris"
        ],
        "at": "2026-11-01T16:05:00-05:00",
        "text": "Recent searches are shipped: the last five show under the field. Can Shelvorn check them on a phone?"
      },
      {
        "ref": "MT-107.2",
        "from": "Alba",
        "to": [
          "Shelvorn"
        ],
        "cc": [
          "Dr. Kivo",
          "Iris"
        ],
        "at": "2026-11-01T16:30:00-05:00",
        "text": "Shelvorn, please check recent searches on a phone with the keyboard up."
      },
      {
        "ref": "MT-107.3",
        "from": "Shelvorn",
        "to": [
          "Alba"
        ],
        "cc": [
          "Dr. Kivo",
          "Iris"
        ],
        "at": "2026-11-01T17:15:00-05:00",
        "text": "Checked on a phone. The five show, but the sheet runs under the keyboard."
      },
      {
        "ref": "MT-107.4",
        "from": "Alba",
        "to": [
          "Dr. Kivo"
        ],
        "cc": [
          "Shelvorn",
          "Iris"
        ],
        "at": "2026-11-01T19:10:00-05:00",
        "text": "I wrote the Search notes down as AR-4. We still need a rows-per-group number.",
        "artifactRefs": [
          "AR-4"
        ]
      }
    ]
  }
];

export const PAGES: ProjectPage[] = [
  {
    "ref": "PG-1",
    "projectId": "quarterdeck",
    "title": "Mission control",
    "by": "Alba",
    "updatedAt": "2026-11-02T09:58:00-05:00",
    "live": true,
    "file": "pages/mission-control.html"
  },
  {
    "ref": "PG-2",
    "projectId": "quarterdeck",
    "title": "Search results layout",
    "by": "Dr. Kivo",
    "updatedAt": "2026-11-02T07:00:00-05:00",
    "live": false,
    "file": null
  },
  {
    "ref": "PG-3",
    "projectId": "heron-forge",
    "title": "Bridge runbook",
    "by": "Shelvorn",
    "updatedAt": "2026-11-01T15:00:00-05:00",
    "live": false,
    "file": null
  }
];

export const ARTIFACTS: PackArtifact[] = [
  {
    "ref": "AR-1",
    "name": "search-groups-test.log",
    "kind": "log",
    "projectId": "quarterdeck",
    "by": "Dr. Kivo",
    "addedAt": "2026-11-02T09:05:00-05:00",
    "size": "0.4 KB",
    "laneIds": [
      "l-sea"
    ],
    "cardIds": [
      "alba-1"
    ],
    "storage": "R2 bucket, key quarterdeck/logs/search-groups-test.log",
    "text": "09:01:12 load example data: 9 cards, 7 lanes, 3 projects\n09:01:13 group limit=5 viewport=440x956 keyboard=up\n09:01:13 groups shown: Chats 3, Task Cards 5 (+4 more), Projects 2, Lanes 1, Mail 0\n09:01:14 all five groups visible on first screen: yes\n09:02:40 group limit=3: Chats group cut at 3 of 3, Task Cards 3 (+6 more); a Chats match in row 4 would need one more tap\n09:03:05 result: 5 per group fits with the keyboard up; 3 hides too much"
  },
  {
    "ref": "AR-2",
    "name": "build-2026-11-02.log",
    "kind": "log",
    "projectId": "quarterdeck",
    "by": "Iris",
    "addedAt": "2026-11-02T08:31:00-05:00",
    "size": "0.2 KB",
    "laneIds": [
      "l-set",
      "l-sea"
    ],
    "cardIds": [],
    "storage": "R2 bucket, key quarterdeck/logs/build-2026-11-02.log",
    "text": "08:29:02 npm run build:app ... ok (first screen 97 KB)\n08:30:11 npm run test:chat ... 112 passed\n08:30:55 npm run design:check ... 30 screens, 0 spills\n08:31:00 all checks passed"
  },
  {
    "ref": "AR-3",
    "name": "settings-context.md",
    "kind": "context",
    "projectId": "quarterdeck",
    "by": "Alba",
    "addedAt": "2026-11-01T17:40:00-05:00",
    "size": "0.2 KB",
    "laneIds": [
      "l-set"
    ],
    "cardIds": [
      "c1",
      "c2"
    ],
    "storage": "R2 bucket, key quarterdeck/context/settings-context.md",
    "text": "# Settings at launch\n- Sections: Bots, Appearance, Add-ons, Storage, Account. Notifications later.\n- Account: Email and Log out only.\n- Appearance: System, Light and Dark.\n- New device default: still open (Task Card c1)."
  },
  {
    "ref": "AR-4",
    "name": "search-context.md",
    "kind": "context",
    "projectId": "quarterdeck",
    "by": "Alba",
    "addedAt": "2026-11-01T19:05:00-05:00",
    "size": "0.2 KB",
    "laneIds": [
      "l-sea"
    ],
    "cardIds": [
      "alba-1",
      "c4"
    ],
    "storage": "R2 bucket, key quarterdeck/context/search-context.md",
    "text": "# Search\n- Groups in this order: Chats, Task Cards, Projects, Lanes, Mail.\n- Cmd+K opens Search on a Mac; a full-screen sheet on a phone.\n- Open question: how many rows per group (Task Card alba-1)."
  }
];

const NO_EDITS: CardEdits = { edits: [], seenAt: null };

export const laneStream = (laneId: string): LaneStream | undefined => STREAMS[laneId];
export const cardEdits = (cardId: string): CardEdits => EDITS[cardId] ?? NO_EDITS;
