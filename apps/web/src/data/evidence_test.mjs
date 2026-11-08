import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import esbuild from "esbuild";

async function load(entry, flags = {}) {
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: "esm", define: { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true", ...flags }, loader: { ".json": "json", ".html": "text" } });
  return import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
}

const { createExampleData } = await load("src/data/example-data.ts");
const { readSwitches } = await load("src/data/switches.ts");

const make = (fixtures) => createExampleData({ delay: 0, fail: new Set(), fixtures, empty: false });
const shipped = JSON.parse(fs.readFileSync("src/data/evidence.json", "utf8"));
const fixtureFile = JSON.parse(fs.readFileSync("src/data/evidence-fixtures.json", "utf8"));
const EV_IDS = fixtureFile.fixtures.map((entry) => entry.taskCard.card.id);

test("alba-1's shipped evidence maps to its pictures, video, links and Shelvorn's check", async () => {
  const evidence = await make("off").evidence("alba-1");
  assert.deepEqual(
    evidence.media.map((item) => [item.id, item.kind, item.role, item.target]),
    [
      ["ev-a1-build", "image", "build", "ev-a1-target"],
      ["ev-a1-target", "image", "target", null],
      ["ev-a1-video", "video", "image", null],
    ],
  );
  assert.ok(evidence.media.every((item) => item.src.startsWith("/evidence/media/")));
  assert.deepEqual(
    evidence.links.map((link) => [link.kind, link.status]),
    [
      ["preview", null],
      ["live", "up"],
    ],
  );
  assert.equal(evidence.check.by, "Shelvorn");
  assert.equal(evidence.doneBy, "Alba");
});

test("a card with no evidence record gets none", async () => {
  assert.equal(await make("off").evidence("shelvorn-1"), null);
});

const local = (file) => file.slice(file.lastIndexOf("media/"));
const filesOf = (records) => records.flatMap((record) => [...record.media.flatMap((item) => [item.file, ...(item.poster ? [item.poster] : [])]), ...record.links.map((link) => link.shot)]).map(local);

test("every file the shipped evidence names ships with the app, under public", () => {
  const files = filesOf(Object.values(shipped.cards));
  assert.equal(files.length, 6);
  assert.deepEqual(
    files.filter((file) => !fs.existsSync("public/evidence/" + file)),
    [],
  );
});

test("valid test evidence files live under fixtures, which only a --fixtures build copies", () => {
  const shippedFiles = new Set(filesOf(Object.values(shipped.cards)));
  const testOnly = [...new Set(filesOf(fixtureFile.fixtures.filter((entry) => entry.taskCard.card.id !== "fx-ev-unsafe").map((entry) => entry.evidence)))].filter((file) => !shippedFiles.has(file));
  assert.equal(testOnly.length, 8);
  assert.deepEqual(
    testOnly.filter((file) => !fs.existsSync("fixtures/evidence/" + file) || fs.existsSync("public/evidence/" + file)),
    [],
  );
});

test("every non-attack evidence fixture supplies usable paths to the real media mapper", async () => {
  const { toEvidence } = await load("src/data/evidence.ts");
  for (const entry of fixtureFile.fixtures.filter((item) => item.taskCard.card.id !== "fx-ev-unsafe")) {
    const evidence = toEvidence(entry.evidence);
    const paths = [...evidence.media.flatMap((item) => [item.src, ...(item.poster !== null ? [item.poster] : [])]), ...evidence.links.map((link) => link.shot)];
    for (const path of paths) assert.ok(path.startsWith("/evidence/media/"), entry.fixture + ": " + path);
  }
});

test("the EV test cards and their evidence load only with ?fixtures=evidence", async () => {
  assert.equal(readSwitches("?fixtures=evidence").fixtures, "evidence");
  const off = make("off");
  assert.equal(await off.evidence(EV_IDS[0]), null);
  assert.deepEqual((await off.load()).cards.filter((card) => EV_IDS.includes(card.id)), []);
  const on = make("evidence");
  assert.equal((await on.evidence(EV_IDS[0])).media.length, 8);
  assert.deepEqual(
    (await on.load()).cards.filter((card) => EV_IDS.includes(card.id)).map((card) => card.id).sort(),
    [...EV_IDS].sort(),
  );
});

test("EV-7's card, its Page with no file and its pictures load only with ?fixtures=evidence", async () => {
  const off = await make("off").load();
  assert.equal(off.cards.some((card) => card.id === "ev7-card"), false);
  assert.equal(off.pages.some((page) => page.ref === "PG-901"), false);
  const on = make("evidence");
  const world = await on.load();
  assert.equal(world.cards.some((card) => card.id === "ev7-card"), true);
  assert.deepEqual(world.pages.filter((page) => page.ref === "PG-901").map((page) => page.file), [null]);
  const evidence = await on.evidence("ev7-card");
  assert.deepEqual(
    evidence.media.map((item) => item.src),
    ["/evidence/media/fixture-picture-1.png", "/evidence/media/fixture-picture-2.png", "/evidence/media/fixture-picture-3.png"],
  );
  assert.ok(evidence.media.every((item) => fs.existsSync("fixtures" + item.src)));
});

const attack = (file, kind = "image") => ({
  doneBy: "Alba",
  media: [{ id: "unsafe", kind, file, poster: file, caption: "Unavailable evidence", by: "Alba", at: "" }],
  links: [{ id: "shot", kind: "preview", title: "Preview", url: "https://example.com", shot: file }],
  check: null,
});

test("media traversal becomes unavailable in the default build", async () => {
  const { toEvidence } = await load("src/data/evidence.ts", { __QD_FIXTURES__: "false" });
  const evidence = toEvidence(attack("media/../../app.js"));
  assert.equal(evidence.media[0].src, "");
  assert.equal(evidence.media[0].poster, "");
  assert.equal(evidence.links[0].shot, "");
});

for (const [mode, flags] of [
  ["default", { __QD_PREVIEW__: "false", __QD_FIXTURES__: "false" }],
  ["preview", { __QD_PREVIEW__: "true", __QD_FIXTURES__: "false" }],
  ["fixtures", { __QD_PREVIEW__: "false", __QD_FIXTURES__: "true" }],
  ["preview fixtures", { __QD_PREVIEW__: "true", __QD_FIXTURES__: "true" }],
]) {
  const { toEvidence } = await load("src/data/evidence.ts", flags);
  const preview = flags.__QD_PREVIEW__ === "true";
  const base = preview ? "evidence/media/" : "/evidence/media/";
  const page = preview ? "https://preview.example.com/design/index.html" : "https://preview.example.com/design/queue/card";
  const folder = preview ? "/design/" : "/";
  test(mode + ": bot path syntax cannot become a media address", () => {
    for (const file of [
      "", ".", "..", "/picture.png", "//example.com/picture.png", "media/", "media//picture.png",
      "media/./picture.png", "media/../picture.png", "media/../../picture.png", "other/media/picture.png",
      "media/nested/picture.png", "media\\picture.png", "media/..\\picture.png",
      "media/%2e%2e%2fpicture.png", "media/%2E%2E/picture.png", "media/picture%2fother.png",
      "media/picture%5cother.png", "media/%252e%252e%252fpicture.png", "media/picture.png?download",
      "media/picture.png#part", "media/picture\n.png", "media/picture\u0000.png", "media/\ud800.png",
      "media/picture.svg", "media/page.html", "https://example.com/picture.png",
    ]) {
      const evidence = toEvidence(attack(file));
      assert.equal(evidence.media[0].src, "", file);
      assert.equal(evidence.media[0].poster, "", file);
      assert.equal(evidence.links[0].shot, "", file);
    }
  });
  test(mode + ": accepted filenames are encoded under the fixed media base", () => {
    for (const file of ["picture.png", "media/picture.png", "media/Phone shot 1.png", "media/café.webp"]) {
      const evidence = toEvidence(attack(file));
      for (const src of [evidence.media[0].src, evidence.media[0].poster, evidence.links[0].shot]) {
        assert.ok(src.startsWith(base), src);
        const address = new URL(src, page);
        assert.equal(address.origin, "https://preview.example.com");
        assert.ok(address.pathname.startsWith(folder + "evidence/media/"), address.pathname);
        assert.equal(address.search + address.hash, "");
      }
    }
    assert.equal(toEvidence(attack("media/Phone shot 1.png")).media[0].src, base + "Phone%20shot%201.png");
    assert.equal(toEvidence(attack("media/café.webp")).links[0].shot, base + "caf%C3%A9.webp");
  });
  test(mode + ": video paths reject traversal before the viewer can offer a download", () => {
    for (const file of ["media/../../video.mp4", "media/%2e%2e%2fvideo.webm", "media/video.webm?download", "/video.webm"]) {
      assert.equal(toEvidence(attack(file, "video")).media[0].src, "", file);
    }
    const evidence = toEvidence(attack("media/video.webm", "video"));
    assert.equal(evidence.media[0].src, base + "video.webm");
    assert.equal(evidence.media[0].poster, "");
    assert.equal(evidence.links[0].shot, "");
    assert.equal(toEvidence(attack("media/picture.png", "video")).media[0].src, "");
  });
}
