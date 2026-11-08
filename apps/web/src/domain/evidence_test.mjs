import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";
import { card } from "./fixture.mjs";

const { evidenceView, besideTargets, checkLine, viewerCaption, webAddress } = await loadTs("src/domain/evidence.ts");

const NOW = Date.parse("2026-11-02T10:00:00-05:00");
const WORLD = {
  pages: [
    { ref: "PG-1", projectId: "quarterdeck", title: "Mission control", by: "Iris", updatedAt: "2026-11-02T09:00:00-05:00", live: true, file: "mission.html" },
    { ref: "PG-2", projectId: "quarterdeck", title: "Search notes", by: "Alba", updatedAt: "2026-11-02T09:00:00-05:00", live: false, file: null },
  ],
  artifacts: [{ ref: "AR-1", name: "search.log", kind: "log", projectId: "quarterdeck", by: "Alba", addedAt: "2026-11-02T09:00:00-05:00", size: "1 KB", laneIds: [], cardIds: [], storage: "", text: "one\ntwo" }],
  mail: [{ ref: "MT-101", subject: "Search", projectId: "quarterdeck", laneId: "l-sea", cardId: null, bots: ["Alba"], mails: [{ ref: "MT-101.1", from: "Alba", to: ["Iris"], at: "2026-11-02T09:00:00-05:00", text: "Hello", refs: [] }] }],
};
const picture = (id, fields = {}) => ({ id, kind: "image", role: "image", src: "/evidence/" + id + ".png", caption: "Picture " + id, by: "Alba", at: "2026-11-02T09:12:00-05:00", target: null, poster: null, length: null, type: null, ...fields });
const proof = (fields = {}) => ({ doneBy: "Alba", pageRef: null, media: [], links: [], check: null, ...fields });
const kinds = (view) => view.thumbs.map((thumb) => (thumb.kind === "media" ? thumb.media.id : thumb.tile.kind + (thumb.tile.kind === "More" ? " " + thumb.tile.title : "")));

test("a card without an evidence record takes the same path: its tiles, the same slots, See all with its count, and no check line", () => {
  const many = card({ id: "old", evidence: ["MT-101", "AR-1", "PG-1", "PG-2"] });
  const view = evidenceView(many, WORLD, null, 6, NOW);
  assert.deepEqual(kinds(view), ["Page", "Page", "Artifact", "Mail"]);
  assert.deepEqual(view.seeAll, { page: "PG-1", text: "See all 4 on Page" });
  assert.equal(view.check, null);
  assert.deepEqual(kinds(evidenceView(many, WORLD, null, 3, NOW)), ["Page", "Page", "More +2 more"]);
});

test("pictures and videos come first, a built picture beside its target, then the Page, Artifact and Mail tiles", () => {
  const media = [picture("target", { role: "target" }), picture("video", { kind: "video" }), picture("build", { role: "build", target: "target" })];
  assert.deepEqual(besideTargets(media).map((item) => item.id), ["video", "build", "target"]);
  const view = evidenceView(card({ id: "mixed", evidence: ["AR-1"] }), WORLD, proof({ media }), 6, NOW);
  assert.deepEqual(kinds(view), ["video", "build", "target", "Artifact"]);
  assert.deepEqual(view.viewer.map((item) => item.id), ["video", "build", "target"]);
});

test("the phone shows 3 slots and the Mac 6; the rest becomes +N more, and See all counts every item", () => {
  const media = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => picture("p" + n));
  const evidence = proof({ media, pageRef: "PG-1" });
  const phone = evidenceView(card({ id: "many" }), WORLD, evidence, 3, NOW);
  assert.deepEqual(kinds(phone), ["p1", "p2", "More +6 more"]);
  const mac = evidenceView(card({ id: "many" }), WORLD, evidence, 6, NOW);
  assert.deepEqual(kinds(mac), ["p1", "p2", "p3", "p4", "p5", "More +3 more"]);
  assert.deepEqual(mac.seeAll, { page: "PG-1", text: "See all 8 on Page" });
  assert.equal(mac.viewer.length, 8);
});

test("See all shows only when the card's Page has a file; without it +N more offers to show them here", () => {
  const media = [1, 2, 3, 4].map((n) => picture("p" + n));
  const view = evidenceView(card({ id: "nofile", evidence: ["PG-2"] }), WORLD, proof({ media }), 3, NOW);
  assert.equal(view.seeAll, null);
  assert.deepEqual(view.thumbs[2].tile, { kind: "More", code: "", title: "+3 more", meta: "Show them here", lines: [], opens: true });
  assert.deepEqual(kinds(evidenceView(card({ id: "nofile", evidence: ["PG-2"] }), WORLD, proof({ media }), Infinity, NOW)), ["p1", "p2", "p3", "p4", "Page"]);
});

test("evidence links accept only HTTPS addresses", () => {
  assert.equal(webAddress("http://example.com"), null);
  assert.equal(webAddress("https://example.com/search")?.href, "https://example.com/search");
  for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "example.com", ""]) assert.equal(webAddress(bad), null, bad);
});

test("evidence links reject user information even when the title claims a trusted service", () => {
  for (const address of ["https://trusted.example@actual.example.com", "https://user:password@example.com", "https://%75ser@example.com"]) {
    assert.equal(webAddress(address), null, address);
  }
});

test("evidence links reject local names including case and trailing-dot variants", () => {
  for (const host of ["localhost", "LOCALHOST.", "sub.localhost", "printer", "service.local", "sub.service.local.", "service.INTERNAL."]) {
    assert.equal(webAddress("https://" + host + "/review"), null, host);
  }
});

test("evidence links reject private, loopback, link-local and nonpublic IPv4 literals", () => {
  for (const host of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "127.8.9.10", "169.254.1.2", "172.16.0.1", "172.31.255.254", "192.168.1.2", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(webAddress("https://" + host), null, host);
  }
});

test("evidence links reject alternate browser-normalized IPv4 spellings", () => {
  for (const host of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0x0a000001", "3232235777", "0xa9fe0102"]) {
    assert.equal(webAddress("https://" + host), null, host);
  }
});

test("evidence links reject loopback, private, link-local and mapped IPv6 literals", () => {
  for (const host of ["[::]", "[::1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[ff02::1]", "[::ffff:127.0.0.1]", "[::ffff:192.168.1.2]", "[::ffff:a00:1]", "[64:ff9b::a00:1]"]) {
    assert.equal(webAddress("https://" + host), null, host);
  }
});

test("public HTTPS destinations are normalized without a service allow-list", () => {
  for (const address of ["https://example.com/review", "https://another-service.example/review", "https://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://localhost.example.com/"]) {
    assert.equal(webAddress(address)?.href, address);
  }
  assert.equal(webAddress("HTTPS://BÜCHER.EXAMPLE:443/review")?.hostname, "xn--bcher-kva.example");
});

test("a deceptive title cannot replace the hostname parsed from the real address", () => {
  const links = [{ id: "deceptive", kind: "preview", title: "Trusted service", url: "HTTPS://ACTUAL.EXAMPLE.COM:443/review", shot: "", at: "2026-11-02T09:00:00-05:00", gated: false }];
  const row = evidenceView(card({ id: "deceptive" }), WORLD, proof({ links }), 3, NOW).links[0];
  assert.equal(row.title, "Trusted service");
  assert.equal(row.url, "https://actual.example.com/review");
  assert.equal(row.hostname, "actual.example.com");
});

test("a bot link row exposes its nonstandard port", () => {
  const links = [{ id: "port", kind: "preview", title: "Preview", url: "HTTPS://EXAMPLE.COM:8443/review", shot: "", at: "2026-11-02T09:00:00-05:00", gated: false }];
  const row = evidenceView(card({ id: "port" }), WORLD, proof({ links }), 3, NOW).links[0];
  assert.equal(row.hostname, "example.com:8443");
});

test("a rejected destination reaches the row without an active address or hostname", () => {
  const links = [{ id: "blocked", kind: "preview", title: "Unsafe service", url: "http://example.com", shot: "", at: "2026-11-02T09:00:00-05:00", gated: false }];
  const row = evidenceView(card({ id: "blocked" }), WORLD, proof({ links }), 3, NOW).links[0];
  assert.equal(row.title, "Unsafe service");
  assert.equal(row.url, null);
  assert.equal(row.hostname, null);
});

test("link rows say when they were updated or delivered, and a live service is up or down as the data says", () => {
  const links = [
    { id: "pre", kind: "preview", title: "Preview: Search v3", url: "https://preview.example.com", shot: "/s.png", at: "2026-11-02T09:10:00-05:00", gated: true, status: null, downSince: null },
    { id: "up", kind: "live", title: "Live service: Search", url: "https://example.com/search", shot: "/l.png", at: "2026-10-30T16:00:00-05:00", gated: false, status: "up", downSince: null },
    { id: "down", kind: "live", title: "Live service: Mail sync", url: "https://example.com/sync", shot: "/m.png", at: "2026-11-01T11:00:00-05:00", gated: false, status: "down", downSince: "2026-11-02T09:20:00-05:00" },
  ];
  const rows = evidenceView(card({ id: "links" }), WORLD, proof({ links }), 3, NOW).links;
  assert.deepEqual(
    rows.map((row) => [row.when, row.status, row.gated]),
    [
      ["updated 9:10 AM", null, true],
      ["delivered Fri 5:00 PM", { up: true, text: "up" }, false],
      ["delivered Sun 11:00 AM", { up: false, text: "down since 9:20 AM" }, false],
    ],
  );
});

test("the check line counts only another bot's check, names failed checks, and never shows a self-check's count", () => {
  const checks = (results) => results.map((passed, n) => ({ name: "Check " + (n + 1), passed }));
  assert.deepEqual(checkLine(proof({ check: { by: "Shelvorn", checks: checks([true, true, true]) } })), { text: "Checked by Shelvorn: 3 of 3 checks pass", tone: "pass", failed: null });
  assert.deepEqual(checkLine(proof({ check: { by: "Shelvorn", checks: checks([true, false, true]) } })), { text: "Checked by Shelvorn: 2 of 3 checks pass", tone: "fail", failed: "Failed: Check 2" });
  assert.deepEqual(checkLine(proof({ check: { by: "Alba", checks: checks([true, true, true]) } })), { text: "Not checked by another bot yet", tone: "quiet", failed: null });
  assert.deepEqual(checkLine(proof()), { text: "Not checked by another bot yet", tone: "quiet", failed: null });
});

test("the viewer caption names the bot and the time", () => {
  assert.equal(viewerCaption(picture("a", { caption: "Search sheet, phone" }), NOW), "Search sheet, phone · Alba 9:12 AM");
});
