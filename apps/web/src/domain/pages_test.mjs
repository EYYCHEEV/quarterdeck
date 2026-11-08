import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const pages = await loadTs("src/domain/pages.ts");
const { parseRoute, href } = await loadTs("src/domain/routes.ts");

const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const PUBLIC_ADDRESS = "https://pages-public.example.com/p/aaaqeayeaudaocajbifqydiob4";

const page = (over) => ({
  ref: "PG-0",
  projectId: "quarterdeck",
  title: "Untitled",
  by: "Alba",
  updatedAt: "2026-11-02T09:00:00-05:00",
  live: false,
  file: "pages/x.html",
  laneId: null,
  pinned: false,
  current: 1,
  versions: [],
  public: null,
  reading: null,
  ...over,
});

const version = (n, madeAt, file = "pages/v" + n + ".html") => ({ n, madeAt, madeBy: "Alba", file, kept: true });

const LANES = [
  { id: "l-sea", name: "Search" },
  { id: "l-set", name: "Settings and theme" },
];

const WORLD = {
  lanes: LANES,
  pages: [
    page({ ref: "PG-1", title: "Mission control", live: true, pinned: true, updatedAt: "2026-11-02T09:58:00-05:00" }),
    page({ ref: "PG-2", title: "Search results layout", by: "Dr. Kivo", laneId: "l-sea", updatedAt: "2026-11-02T07:00:00-05:00", versions: [version(1, "2026-11-01T16:00:00-05:00"), version(2, "2026-11-02T07:00:00-05:00")], current: 2 }),
    page({ ref: "PG-4", title: "Theme picker demo", by: "Shelvorn", laneId: "l-set", updatedAt: "2026-11-02T08:30:00-05:00", versions: [version(1, "2026-10-20T08:30:00-04:00")], public: { version: 1, madeBy: "Captain", madeAt: "2026-10-21T10:00:00-04:00", link: "pages-public.example.com/theme-picker-demo", removal: "none" } }),
    page({ ref: "PG-5", title: "Launch checklist", updatedAt: "2026-10-28T12:00:00-04:00" }),
    page({ ref: "PG-6", title: "Other project", projectId: "heron-forge" }),
  ],
};

const refs = (view) => view.rows.map((row) => row.ref);
const view = (query = {}) => pages.viewPages(WORLD, "quarterdeck", { ...pages.EMPTY_PAGE_QUERY, ...query }, NOW);

test("a project's Pages come pinned first, then last updated first, and only that project's", () => {
  assert.deepEqual(refs(view()), ["PG-1", "PG-4", "PG-2", "PG-5"]);
  assert.equal(view().pinned, 1);
});

test("pinned Pages stay on top in every sort", () => {
  assert.deepEqual(refs(view({ sort: "title" })), ["PG-1", "PG-5", "PG-2", "PG-4"]);
  assert.deepEqual(refs(view({ sort: "added" })), ["PG-1", "PG-2", "PG-5", "PG-4"]);
});

test("the Added sort and filter use the first version's time, and a Page without versions its updated time", () => {
  assert.equal(pages.addedAt(WORLD.pages[1]), "2026-11-01T16:00:00-05:00");
  assert.equal(pages.addedAt(WORLD.pages[3]), "2026-10-28T12:00:00-04:00");
  assert.deepEqual(refs(view({ filters: { added: "today" } })), ["PG-1"]);
  assert.deepEqual(refs(view({ filters: { added: "week" } })), ["PG-1", "PG-2", "PG-5"]);
  assert.deepEqual(refs(view({ filters: { added: "older" } })), ["PG-4"]);
});

test("a Page added a week ago leaves Last 7 days and joins Older", () => {
  const edge = { lanes: [], pages: [page({ ref: "PG-7", versions: [version(1, "2026-10-26T10:00:00-04:00")] }), page({ ref: "PG-8", versions: [version(1, "2026-10-27T10:00:00-04:00")] })] };
  const run = (added) => pages.viewPages(edge, "quarterdeck", { ...pages.EMPTY_PAGE_QUERY, filters: { added } }, NOW).rows.map((row) => row.ref);
  assert.deepEqual(run("week"), ["PG-8"]);
  assert.deepEqual(run("older"), ["PG-7"]);
});

test("filters narrow by Lane, maker, visibility and Live, and name themselves", () => {
  assert.deepEqual(refs(view({ filters: { lane: "l-sea" } })), ["PG-2"]);
  assert.deepEqual(refs(view({ filters: { lane: "none" } })), ["PG-1", "PG-5"]);
  assert.deepEqual(refs(view({ filters: { by: "Shelvorn" } })), ["PG-4"]);
  assert.deepEqual(refs(view({ filters: { visibility: "Public" } })), ["PG-4"]);
  assert.deepEqual(refs(view({ filters: { visibility: "Private" } })), ["PG-1", "PG-2", "PG-5"]);
  assert.deepEqual(refs(view({ filters: { live: "live" } })), ["PG-1"]);
  assert.deepEqual(refs(view({ filters: { live: "not-live" } })), ["PG-4", "PG-2", "PG-5"]);
  const narrowed = view({ filters: { lane: "l-sea", by: "Dr. Kivo" }, sort: "title" });
  assert.deepEqual(narrowed.chips, [
    { key: "lane", text: "Lane: Search" },
    { key: "by", text: "Made by: Dr. Kivo" },
    { key: "sort", text: "Sorted by title" },
  ]);
  assert.equal(narrowed.filterCount, 2);
});

test("the filter groups list what is in use: Lanes with Pages, No Lane, makers, visibility, Live and Added", () => {
  const groups = view().groups;
  assert.deepEqual(groups.map((group) => group.key), ["lane", "by", "visibility", "live", "added"]);
  assert.deepEqual(groups[0].choices, [
    { value: "l-sea", label: "Search" },
    { value: "l-set", label: "Settings and theme" },
    { value: "none", label: "No Lane" },
  ]);
  assert.deepEqual(groups[1].choices.map((choice) => choice.value), ["Alba", "Dr. Kivo", "Shelvorn"]);
  assert.deepEqual(groups[2].choices.map((choice) => choice.label), ["Private", "Public"]);
  assert.deepEqual(groups[4].choices.map((choice) => choice.label), ["Today", "Last 7 days", "Older"]);
});

test("search reads the title, Lane, maker and reference, and every word must match", () => {
  assert.deepEqual(refs(view({ text: "kivo search" })), ["PG-2"]);
  assert.deepEqual(refs(view({ text: "no lane" })), ["PG-1", "PG-5"]);
  assert.deepEqual(refs(view({ text: "pg-4" })), ["PG-4"]);
  assert.deepEqual(refs(view({ text: "zebra" })), []);
});

test("the subtitle counts the rows on screen out of the project's Pages and names the sort", () => {
  assert.equal(view().line, "4 Pages · Last updated first");
  assert.equal(view({ filters: { by: "Alba" } }).line, "2 of 4 Pages · Last updated first");
  assert.equal(view({ text: "zebra" }).line, "0 of 4 Pages · Last updated first");
  assert.equal(view({ sort: "added" }).line, "4 Pages · Added, newest first");
  assert.equal(view({ sort: "title" }).line, "4 Pages · Title, A to Z");
  assert.equal(pages.viewPages(WORLD, "heron-forge", pages.EMPTY_PAGE_QUERY, NOW).line, "1 Page · Last updated first");
});

test("a row gives the phone line and the Mac table cells from the same values", () => {
  const rows = Object.fromEntries(view().rows.map((row) => [row.ref, row]));
  assert.deepEqual(rows["PG-1"].meta, ["no Lane", "Alba", "2m ago"]);
  assert.deepEqual(rows["PG-2"].meta, ["Search", "Dr. Kivo", "3h ago"]);
  assert.equal(rows["PG-4"].visibility, "Public");
  assert.equal(rows["PG-2"].visibility, "Private");
  assert.equal(rows["PG-5"].updated, "Wed");
});

test("the viewer's head names the Lane or no Lane, the maker and the update time", () => {
  assert.deepEqual(pages.headParts(WORLD.pages[0], null, NOW), ["no Lane", "Alba", "updated 9:58 AM"]);
  assert.deepEqual(pages.headParts(WORLD.pages[1], "Search", NOW), ["Search", "Dr. Kivo", "updated 7:00 AM"]);
  assert.deepEqual(pages.headParts(WORLD.pages[3], null, NOW), ["no Lane", "Alba", "updated Wed 12:00 PM"]);
});

test("marks are Live when it keeps updating and Public only when he made it public", () => {
  assert.deepEqual(pages.marksOf(WORLD.pages[0]), ["Live"]);
  assert.deepEqual(pages.marksOf(WORLD.pages[1]), []);
  assert.deepEqual(pages.marksOf(WORLD.pages[2]), ["Public"]);
});

const reading = page({ ref: "PG-3", file: "pages/v2.html", current: 2, versions: [version(1, "2026-11-01T15:00:00-05:00"), version(2, "2026-11-02T09:35:00-05:00")], reading: { version: 1, at: "2026-11-02T09:20:00-05:00" } });

test("a Page he was reading at an older version shows that version and the ready line; a fresh open shows the newest", () => {
  const viewing = pages.startViewing(reading, null);
  assert.deepEqual(viewing, { shown: 1, trying: null });
  assert.equal(pages.readyVersion(reading, viewing), 2);
  assert.equal(pages.readyLine(2), "Version 2 is ready.");
  const fresh = pages.startViewing({ ...reading, reading: null }, null);
  assert.deepEqual(fresh, { shown: 2, trying: null });
  assert.equal(pages.readyVersion(reading, fresh), null);
});

test("Show tries the newest version, the one he reads stays until it has loaded, and then the line is gone", () => {
  const start = pages.startViewing(reading, null);
  const trying = pages.showReady(reading, start);
  assert.deepEqual(trying, { shown: 1, trying: 2 });
  assert.equal(pages.readyVersion(reading, trying), 2);
  const landed = pages.landed(trying);
  assert.deepEqual(landed, { shown: 2, trying: null });
  assert.equal(pages.readyVersion(reading, landed), null);
});

test("Show tapped again while the version is loading changes nothing", () => {
  const trying = pages.showReady(reading, pages.startViewing(reading, null));
  assert.deepEqual(pages.showReady(reading, trying), trying);
});

test("Show does nothing when he already reads the newest version, and a stored version wins over the example reading", () => {
  const latest = pages.startViewing({ ...reading, reading: null }, null);
  assert.equal(pages.showReady(reading, latest), latest);
  assert.deepEqual(pages.startViewing(reading, 2), { shown: 2, trying: null });
  assert.deepEqual(pages.startViewing(reading, 9), { shown: 2, trying: null });
});

test("a newer version arriving while he reads brings the ready line without moving the version he reads", () => {
  const before = page({ file: "pages/v1.html", current: 1, versions: [version(1, "2026-11-02T08:00:00-05:00")] });
  const viewing = pages.startViewing(before, null);
  const after = { ...before, current: 2, file: "pages/v2.html", versions: [...before.versions, version(2, "2026-11-02T09:00:00-05:00")] };
  assert.equal(pages.readyVersion(after, viewing), 2);
  assert.equal(viewing.shown, 1);
});

test("each version has its own file, and a Page without a versions list reads its file as the current version", () => {
  assert.equal(pages.fileOfVersion(reading, 1), "pages/v1.html");
  assert.equal(pages.fileOfVersion(reading, 2), "pages/v2.html");
  assert.equal(pages.fileOfVersion(reading, 3), null);
  assert.equal(pages.fileOfVersion(page({ file: "pages/mission.html" }), 1), "pages/mission.html");
});

const publicOne = page({ ref: "PG-3", title: "Bridge runbook", current: 2, versions: [version(1, "2026-11-01T15:00:00-05:00"), version(2, "2026-11-02T09:35:00-05:00")], public: { version: 1, madeBy: "Captain", madeAt: "2026-11-01T17:30:00-05:00", link: PUBLIC_ADDRESS, removal: "none" } });

test("a public Page says which version is public and that a newer one is still private", () => {
  assert.deepEqual(pages.publicLine(publicOne), { text: "Public, version 1", newer: "Version 2 is newer and still private.", link: PUBLIC_ADDRESS, removing: false });
  assert.equal(pages.publicLine(page()), null);
  assert.equal(pages.publicLine({ ...publicOne, current: 1 }).newer, null);
});

test("only the current version can be newer than the public one, and a pending removal says so and drops the newer line", () => {
  const pending = { ...publicOne, public: { ...publicOne.public, removal: "pending" } };
  assert.deepEqual(pages.publicLine(pending), { text: "Public, removal pending", newer: null, link: PUBLIC_ADDRESS, removing: true });
  assert.deepEqual(pages.marksOf(pending), ["Public"]);
  assert.equal(pages.visibilityOf(pending), "Public");
});

test("updating the public version keeps the one public address and moves the version and the time", () => {
  const updated = pages.publish(publicOne, 2, "2026-11-02T15:00:00.000Z", () => assert.fail("an update must not mint an address"));
  assert.deepEqual(updated, { version: 2, madeBy: "Captain", madeAt: "2026-11-02T15:00:00.000Z", link: PUBLIC_ADDRESS, removal: "none" });
  const after = { ...publicOne, public: updated };
  assert.equal(pages.publicLine(after).newer, null);
  assert.equal(pages.publicLine(after).text, "Public, version 2");
});

test("making a private Page public uses the supplied random capability, by the Captain", () => {
  const made = pages.publish(page({ title: "Search results layout", current: 2 }), 2, "2026-11-02T15:00:00.000Z", () => pages.publicAddress((bytes) => bytes.set(Array.from({ length: 16 }, (_, at) => at))));
  assert.deepEqual(made, { version: 2, madeBy: "Captain", madeAt: "2026-11-02T15:00:00.000Z", link: PUBLIC_ADDRESS, removal: "none" });
});

test("duplicate Page titles receive different public capability addresses", () => {
  let draw = 0;
  const mint = () => pages.publicAddress((bytes) => bytes.fill(++draw));
  const first = pages.publish(page({ ref: "PG-A", title: "Shared title" }), 1, "2026-11-02T15:00:00.000Z", mint);
  const second = pages.publish(page({ ref: "PG-B", title: "Shared title" }), 1, "2026-11-02T15:00:00.000Z", mint);
  assert.notEqual(first.link, second.link);
});

test("a public capability encodes the exact sixteen supplied bytes as canonical lowercase base32", () => {
  let draws = 0;
  assert.equal(pages.publicAddress((bytes) => {
    draws += 1;
    assert.equal(bytes.length, 16);
    bytes.set(Array.from({ length: 16 }, (_, at) => at));
  }), PUBLIC_ADDRESS);
  assert.equal(draws, 1);
  assert.equal(pages.publicAddress((bytes) => bytes.fill(255)), "https://pages-public.example.com/p/77777777777777777777777774");
});

test("a public capability preserves each of its 128 input bits", () => {
  const baseline = pages.publicAddress((bytes) => bytes.fill(0));
  const changed = new Set();
  for (let bit = 0; bit < 128; bit += 1) {
    const address = pages.publicAddress((bytes) => { bytes.fill(0); bytes[bit >> 3] = 1 << (7 - (bit & 7)); });
    assert.notEqual(address, baseline);
    assert.match(address, /^https:\/\/pages-public\.example\.com\/p\/[a-z2-7]{25}[aeimquy4]$/);
    changed.add(address);
  }
  assert.equal(changed.size, 128);
});

for (const [kind, title] of [["punctuation-only", "!!!"], ["non-Latin", "東京のメモ"]]) {
  test("a " + kind + " Page title still gets a complete random address", () => {
    const made = pages.publish(page({ title }), 1, "2026-11-02T15:00:00.000Z", () => pages.publicAddress((bytes) => bytes.set(Array.from({ length: 16 }, (_, at) => at))));
    assert.equal(made.link, PUBLIC_ADDRESS);
  });
}

test("a Page with no file cannot be made public, a missing version is refused, and so is one already public or being removed", () => {
  assert.equal(pages.publishRefusal(page({ file: null }), 1), "That Page has no file yet.");
  assert.equal(pages.publishRefusal(page({ current: 2 }), 5), "That version is not kept.");
  assert.equal(pages.publishRefusal(publicOne, 1), "That version is already public.");
  assert.equal(pages.publishRefusal({ ...publicOne, public: { ...publicOne.public, removal: "pending" } }, 2), "The public copy is still being removed.");
  assert.equal(pages.publishRefusal(publicOne, 2), null);
  assert.equal(pages.publishRefusal(page({ current: 2, versions: [version(1, "2026-11-01T15:00:00-05:00")] }), 1), null);
  assert.equal(pages.publishRefusal(page({ current: 2, versions: [{ ...version(1, "2026-11-01T15:00:00-05:00"), kept: false }] }), 1), "That version is not kept.");
});

test("making a Page private never says private: it goes to removal pending until the host confirms", () => {
  assert.deepEqual(pages.makePrivate(publicOne), { ...publicOne.public, removal: "pending" });
  assert.equal(pages.makePrivate(page()), null);
});

test("the more menu offers what the Page's state allows", () => {
  const labels = (item) => pages.menuItems(item).map((entry) => entry.label);
  assert.deepEqual(labels(page()), ["Copy link (Quarterdeck sign-in)", "Open in browser", "Make public..."]);
  assert.deepEqual(labels(publicOne), ["Copy link (Quarterdeck sign-in)", "Open in browser", "Copy public link", "Make private"]);
  assert.deepEqual(labels({ ...publicOne, public: { ...publicOne.public, removal: "pending" } }), ["Copy link (Quarterdeck sign-in)", "Open in browser"]);
  assert.deepEqual(labels(page({ file: null })), ["Copy link (Quarterdeck sign-in)"]);
});

test("the confirm names three warnings and the private-data check, in the flow's words", () => {
  assert.deepEqual(pages.PUBLIC_WARNINGS, ["Anyone with the link can read and copy this exact version, without signing in.", "Not sent to search engines.", "Copies cannot be recalled."]);
  assert.equal(pages.PRIVATE_DATA_CHECK, "No passwords, keys or private data found");
});

test("a confirm opened for one version is told of a newer current version, and of nothing when none is newer", () => {
  assert.equal(pages.askNewer(publicOne, 1), 2);
  assert.equal(pages.askNewer(publicOne, 2), null);
  assert.equal(pages.askNewer({ ...publicOne, current: 3 }, 2), 3);
});

test("the confirm calls a newer version what the public panel calls it", () => {
  assert.equal(pages.newerLine(2), pages.publicLine(publicOne).newer);
  assert.equal(pages.newerLine(3), "Version 3 is newer and still private.");
});

test("asking again names the newer version and keeps the dots of Make public...", () => {
  assert.equal(pages.askAgainLabel(3), "Make version 3 public...");
});

test("previewing a version tries that version and leaves the one he reads until it has loaded", () => {
  const start = pages.startViewing(reading, null);
  assert.deepEqual(pages.showVersion(start, 2), { shown: 1, trying: 2 });
  assert.equal(pages.showVersion(start, 1), start);
});

test("a refused change shows the reason it was refused for", () => {
  const refused = Object.assign(new Error("The public copy is still being removed."), { name: "Refused" });
  assert.equal(pages.refusalText(refused, "Not made public. Try again."), "The public copy is still being removed.");
});

test("any other failure shows the Page screen's own words", () => {
  assert.equal(pages.refusalText(new Error("the example server could not be reached"), "Not made public. Try again."), "Not made public. Try again.");
  assert.equal(pages.refusalText("nope", "Not made private. Try again."), "Not made private. Try again.");
});

test("the Pages list has its own address under the project, next to a Page's", () => {
  assert.deepEqual(parseRoute("/projects/quarterdeck/pages"), { name: "pages", projectId: "quarterdeck" });
  assert.deepEqual(parseRoute("/projects/quarterdeck/pages/PG-2"), { name: "page", projectId: "quarterdeck", ref: "PG-2" });
  assert.equal(href.pages("quarterdeck"), "/projects/quarterdeck/pages");
  assert.deepEqual(parseRoute("/projects/quarterdeck"), { name: "projects", projectId: "quarterdeck" });
  assert.deepEqual(parseRoute("/projects/quarterdeck/pages/PG-2/extra"), { name: "queue", cardId: null });
});
