import { countText, type FilterChoice } from "./query";
import type { Artifact, Project, World } from "./types";

export type ProjectFilterKey = "lead" | "lanes";
export type ProjectSort = "activity" | "name";
export type ProjectQuery = { text: string; filters: Partial<Record<ProjectFilterKey, string>>; sort: ProjectSort };
export type ProjectGroup = { key: ProjectFilterKey; title: string; choices: FilterChoice[] };
export type ProjectsView = { projects: Project[]; count: string; chips: { key: ProjectFilterKey | "sort"; text: string }[]; filterCount: number; groups: ProjectGroup[] };

export type ArtifactQuery = { text: string; kind: string };
export type ArtifactsView = { artifacts: Artifact[]; count: string; kinds: string[] };

export const EMPTY_PROJECT_QUERY: ProjectQuery = { text: "", filters: {}, sort: "activity" };
export const EMPTY_ARTIFACT_QUERY: ArtifactQuery = { text: "", kind: "" };
export const PROJECT_SORTS: FilterChoice[] = [
  { value: "activity", label: "Last activity" },
  { value: "name", label: "Name" },
];

const TITLES: Record<ProjectFilterKey, string> = { lead: "Lead", lanes: "Lanes" };

const wordsOf = (text: string) => text.trim().toLowerCase().split(/\s+/).filter(Boolean);

export function viewProjects(world: Pick<World, "projects" | "lanes">, query: ProjectQuery): ProjectsView {
  const groups: ProjectGroup[] = [
    { key: "lead", title: TITLES.lead, choices: [...new Set(world.projects.map((p) => p.lead))].sort().map((lead) => ({ value: lead, label: lead })) },
    { key: "lanes", title: TITLES.lanes, choices: ["Active", "Done"].map((status) => ({ value: status, label: status })) },
  ];
  const { lead, lanes } = query.filters;
  const words = wordsOf(query.text);
  const projects = world.projects
    .filter((p) => !lead || p.lead === lead)
    .filter((p) => !lanes || world.lanes.some((l) => l.projectId === p.id && l.status === lanes))
    .filter((p) => words.every((word) => [p.name, p.description, p.lead].join(" ").toLowerCase().includes(word)))
    .sort((a, b) => (query.sort === "name" ? a.name.localeCompare(b.name) : Date.parse(b.activeAt) - Date.parse(a.activeAt)));
  const keys = (Object.keys(query.filters) as ProjectFilterKey[]).filter((key) => query.filters[key]);
  const chips = [
    ...keys.map((key) => ({ key, text: TITLES[key] + ": " + query.filters[key] })),
    ...(query.sort === "name" ? [{ key: "sort" as const, text: "Sorted by name" }] : []),
  ];
  return { projects, count: countText(projects.length, world.projects.length), chips, filterCount: keys.length, groups };
}

export function viewArtifacts(artifacts: Artifact[], query: ArtifactQuery): ArtifactsView {
  const words = wordsOf(query.text);
  const shown = artifacts.filter((a) => (!query.kind || a.kind === query.kind) && words.every((word) => [a.name, a.kind, a.by].join(" ").toLowerCase().includes(word)));
  return { artifacts: shown, count: countText(shown.length, artifacts.length, "file", "files"), kinds: [...new Set(artifacts.map((a) => a.kind))].sort() };
}
