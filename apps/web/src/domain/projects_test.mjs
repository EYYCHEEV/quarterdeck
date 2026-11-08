import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "../../tools/load-ts.mjs";

const { viewProjects, viewArtifacts, EMPTY_PROJECT_QUERY, EMPTY_ARTIFACT_QUERY } = await loadTs("src/domain/projects.ts");

const WORLD = {
  projects: [
    { id: "dale-tools", name: "dale-tools", lead: "Dr. Kivo", description: "Small tools for the Dale bot.", activeAt: "2026-11-01T10:00:00-05:00" },
    { id: "quarterdeck", name: "quarterdeck", lead: "Alba", description: "The Quarterdeck web app.", activeAt: "2026-11-02T09:48:00-05:00" },
    { id: "heron-forge", name: "heron-forge", lead: "Shelvorn", description: "Matrix rooms and the bridge.", activeAt: "2026-11-02T08:00:00-05:00" },
  ],
  lanes: [
    { id: "l-set", projectId: "quarterdeck", status: "Active" },
    { id: "l-bri", projectId: "heron-forge", status: "Done" },
    { id: "l-da1", projectId: "dale-tools", status: "Active" },
  ],
};

const ids = (view) => view.projects.map((project) => project.id);

test("projects come most recently active first, or by name", () => {
  assert.deepEqual(ids(viewProjects(WORLD, EMPTY_PROJECT_QUERY)), ["quarterdeck", "heron-forge", "dale-tools"]);
  assert.deepEqual(ids(viewProjects(WORLD, { ...EMPTY_PROJECT_QUERY, sort: "name" })), ["dale-tools", "heron-forge", "quarterdeck"]);
});

test("search, lead and Lane filters narrow the projects, name themselves, and the count says how many of all", () => {
  const all = viewProjects(WORLD, EMPTY_PROJECT_QUERY);
  assert.equal(all.count, "3");
  const done = viewProjects(WORLD, { ...EMPTY_PROJECT_QUERY, filters: { lanes: "Done" } });
  assert.deepEqual([ids(done), done.count, done.chips, done.filterCount], [["heron-forge"], "1 of 3", [{ key: "lanes", text: "Lanes: Done" }], 1]);
  assert.deepEqual(ids(viewProjects(WORLD, { ...EMPTY_PROJECT_QUERY, text: "bridge rooms" })), ["heron-forge"]);
  assert.deepEqual(ids(viewProjects(WORLD, { ...EMPTY_PROJECT_QUERY, filters: { lead: "Alba" } })), ["quarterdeck"]);
});

test("artifacts narrow by search and kind, and the count says how many of all the files", () => {
  const artifacts = [
    { ref: "AR-1", name: "search-groups-test.log", kind: "log", by: "Dr. Kivo" },
    { ref: "AR-3", name: "settings-context.md", kind: "context", by: "Alba" },
  ];
  const all = viewArtifacts(artifacts, EMPTY_ARTIFACT_QUERY);
  assert.deepEqual([all.count, all.kinds], ["2 files", ["context", "log"]]);
  const logs = viewArtifacts(artifacts, { ...EMPTY_ARTIFACT_QUERY, kind: "log" });
  assert.deepEqual([logs.artifacts.map((a) => a.ref), logs.count], [["AR-1"], "1 of 2 files"]);
  assert.deepEqual(viewArtifacts(artifacts, { text: "alba", kind: "" }).artifacts.map((a) => a.ref), ["AR-3"]);
});
