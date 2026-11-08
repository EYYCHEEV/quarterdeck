import { useMemo, useState, type ReactNode } from "react";
import { useChatRows } from "../../data/chat-hooks";
import { useQd, useTrackers, useWorld } from "../../data/hooks";
import { EMPTY_ARTIFACT_QUERY, EMPTY_PROJECT_QUERY, PROJECT_SORTS, viewArtifacts, viewProjects, type ArtifactQuery, type ProjectFilterKey, type ProjectQuery } from "../../domain/projects";
import { withFilter } from "../../domain/query";
import { rankQueue } from "../../domain/queue";
import { href } from "../../domain/routes";
import { anyNew, newCount, projectNewCount } from "../../domain/seen";
import { whenText } from "../../domain/time";
import { projectLine, resolveLanes, type LaneRow } from "../../domain/tracker";
import type { Artifact, Page, Project, World } from "../../domain/types";
import { Avatar } from "../../ui/avatar";
import { ChoiceGroups } from "../../ui/choices";
import { FilterPick } from "../../ui/filter-pick";
import { FilterLine } from "../../ui/chip";
import { cx } from "../../ui/cx";
import { SearchField } from "../../ui/field";
import { Fold } from "../../ui/fold";
import { FlowHead, HeadMenuProvider } from "../../ui/flow-head";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { Sheet } from "../../ui/overlay";
import { Dot, NewMark } from "../../ui/row";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";
import { Toggle } from "../../ui/toggle";

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function LaneLine({ row, waiting, fresh, now, world, selected }: { row: LaneRow; waiting: number; fresh: number; now: number; world: World; selected: boolean }) {
  const { lane, tracker, status } = row;
  const done = status === "Done";
  const lead = world.bots.find((b) => b.name === lane.lead);
  const stage = tracker ? projectLine(tracker, now) : null;
  return (
    <li>
      <Link to={href.lane(lane.id)} className={cx("project-lane-row", selected && "is-selected")} aria-current={selected ? "page" : undefined} data-testid="lane-row" data-id={lane.id}>
        <span className={cx("lane-status-icon", done && "is-done")} aria-label={status} role="img"><Icon name={done ? "check" : "lane"} size="sm" /></span>
        <span className="lane-row-content">
          <span className="lane-row-title"><b>{lane.name}</b><Icon name="chevR" size="xs" /></span>
          <span className="lane-row-counts">
            <span>{waiting ? waiting + " waiting" : done ? "Done" : "No Task Cards waiting"}</span>
            {fresh > 0 && <NewMark count={fresh} />}
          </span>
          {stage && <span className="lane-row-stage" data-testid="lane-stage">{stage.line}</span>}
          {stage?.mark && <span className={cx("lane-row-mark", !!tracker?.blockers.length && "is-blocked")} data-testid="lane-mark">{stage.mark}</span>}
          {!done && <span className="lane-row-now" data-testid="lane-now"><Avatar name={lane.lead} color={lead?.color} size="xs" />{lane.now}</span>}
        </span>
      </Link>
    </li>
  );
}

function PageLine({ page, now }: { page: Page; now: number }) {
  return (
    <li>
      <Link to={href.page(page.projectId, page.ref)} className="group flex min-h-12 items-center gap-2.5 py-1.5 text-note" data-testid="page-row">
        <Icon name="page" size="sm" className="text-ink-3" />
        <span className="grid min-w-0 flex-1 gap-px">
          <b className="font-semibold [overflow-wrap:anywhere] group-hover:underline group-hover:decoration-line-3 group-hover:underline-offset-3">{page.title}</b>
          <span className="flex flex-wrap items-center gap-x-1.5 text-tag text-ink-2">
            {page.by}
            <Dot />
            {page.file ? "updated " + whenText(page.updatedAt, now) : "No file yet"}
          </span>
        </span>
        {page.live && (
          <span className="inline-flex flex-none items-center gap-1 rounded-full bg-green-soft px-2 py-px text-xs font-semibold text-green">
            <Icon name="live" size="xs" />
            Live
          </span>
        )}
        <code className="flex-none rounded-md bg-raised px-1.5 py-px font-mono text-xs text-ink-2">{page.ref}</code>
      </Link>
    </li>
  );
}

function ArtifactLine({ artifact, world, now }: { artifact: Artifact; world: World; now: number }) {
  const used = [...artifact.laneIds.map((id) => world.lanes.find((l) => l.id === id)?.name ?? id), ...artifact.cardIds.map((id) => world.cards.find((c) => c.id === id)?.title ?? id)];
  return (
    <li>
      <Link to={href.artifact(artifact.projectId, artifact.ref)} className="group flex min-h-12 items-center gap-2.5 py-1.5 text-note" data-testid="artifact-row">
        <Icon name={artifact.kind === "log" ? "terminal" : "file"} size="sm" className="text-ink-3" />
        <span className="grid min-w-0 flex-1 gap-px">
          <b className="font-semibold [overflow-wrap:anywhere] group-hover:underline">{artifact.name}</b>
          <span className="flex flex-wrap items-center gap-x-1.5 text-tag text-ink-2">
            {capital(artifact.kind)}
            <Dot />
            {artifact.size}
            <Dot />
            {artifact.by}, {whenText(artifact.addedAt, now)}
          </span>
          {used.length > 0 && <span className="text-tag [overflow-wrap:anywhere] text-ink-2">Used by {used.join(", ")}</span>}
        </span>
        <code className="flex-none rounded-md bg-raised px-1.5 py-px font-mono text-xs text-ink-2">{artifact.ref}</code>
      </Link>
    </li>
  );
}

function Artifacts({ artifacts, world, now, open }: { artifacts: Artifact[]; world: World; now: number; open: boolean }) {
  const [query, setQuery] = useState<ArtifactQuery>(EMPTY_ARTIFACT_QUERY);
  const view = viewArtifacts(artifacts, query);
  return (
    <Fold
      label={
        <span className="flex flex-1 items-center justify-between gap-2">
          Artifacts<span className="text-ink-2">{view.count}</span>
        </span>
      }
      open={open}
      className="mt-3 border-t border-line pt-1"
      summaryClass="flex w-full text-tag"
    >
      <div className="mt-1 flex flex-wrap gap-1.5">
        <SearchField value={query.text} onText={(text) => setQuery({ ...query, text })} label="Search artifacts" className="min-h-11 flex-[1_1_160px]" />
        <label className="artifact-kind">
          <span>Kind</span>
          <select value={query.kind} onChange={(event) => setQuery({ ...query, kind: event.target.value })} aria-label="Artifact kind">
            <option value="">Any</option>
            {view.kinds.map((k) => (
              <option key={k} value={k}>
                {capital(k)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {view.artifacts.length ? (
        <ul className="mt-1">
          {view.artifacts.map((artifact) => (
            <ArtifactLine key={artifact.ref} artifact={artifact} world={world} now={now} />
          ))}
        </ul>
      ) : (
        <p className="py-1.5 text-meta text-ink-2">No artifacts match.</p>
      )}
      <p className="mt-1.5 text-tag text-ink-2">Stored in the R2 bucket (cloud file storage).</p>
    </Fold>
  );
}

function ProjectDetail({ project, world, rows, now, waitingByLane, selectedLane, mac }: { project: Project; world: World; rows: LaneRow[]; now: number; waitingByLane: Map<string, number>; selectedLane?: string; mac: boolean }) {
  const lanes = rows.filter((row) => row.lane.projectId === project.id);
  const waiting = lanes.reduce((sum, row) => sum + (waitingByLane.get(row.lane.id) ?? 0), 0);
  const pages = world.pages.filter((page) => page.projectId === project.id).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const artifacts = world.artifacts.filter((artifact) => artifact.projectId === project.id);
  const lead = world.bots.find((bot) => bot.name === project.lead);
  const tasks = world.tasks.filter((task) => lanes.some((row) => row.lane.id === task.laneId));
  const doneTasks = tasks.filter((task) => task.state === "Done").length;
  const doingTasks = tasks.filter((task) => task.state === "Doing").length;
  const waitingLanes = lanes.filter((row) => row.status !== "Done" && (waitingByLane.get(row.lane.id) ?? 0) > 0);
  const activeLanes = lanes.filter((row) => row.status !== "Done" && !(waitingByLane.get(row.lane.id) ?? 0));
  const finished = lanes.filter((row) => row.status === "Done");
  const finishedNew = finished.reduce((sum, row) => sum + newCount(row.lane, world.bots), 0);
  const line = (row: LaneRow) => <LaneLine key={row.lane.id} row={row} waiting={waitingByLane.get(row.lane.id) ?? 0} fresh={newCount(row.lane, world.bots)} now={now} world={world} selected={row.lane.id === selectedLane} />;
  return (
    <article className="project-detail" data-testid="project-row" id={"project-" + project.id}>
      <div className="project-intro">
        <p className="flow-kicker">Project</p>
        <h1>{project.name}</h1>
        <p className="project-description">{project.description}</p>
        <p className="project-meta"><Avatar name={project.lead} color={lead?.color} size="sm" /><span>Lead {project.lead}</span><Dot /><span>{waiting} Task Cards</span><Dot /><span>{lanes.length} Lanes</span></p>
        <p className="project-task-counts">Tasks: <b>{doneTasks} done</b><span>·</span><b>{doingTasks} in progress</b></p>
      </div>
      {lanes.length ? (
        <div className="project-lanes">
          {waitingLanes.length > 0 && <section><h2 className="flow-section-title">With Task Cards<span>{waitingLanes.length}</span></h2><ul>{waitingLanes.map(line)}</ul></section>}
          {activeLanes.length > 0 && <section><h2 className="flow-section-title">Active<span>{activeLanes.length}</span></h2><ul>{activeLanes.map(line)}</ul></section>}
          {finished.length > 0 && (
            <Fold
              label={
                <>
                  {"Done (" + finished.length + ")"}
                  {finishedNew > 0 && (
                    <>
                      <Dot />
                      <NewMark count={finishedNew} testId="done-new" />
                    </>
                  )}
                </>
              }
              className="done-lanes-fold"
              testId="done-lanes"
            >
              <ul>{finished.map(line)}</ul>
            </Fold>
          )}
        </div>
      ) : (
        <div className="project-empty"><p>No Lanes yet. Ask a bot to start one.</p>{lead && <Link to={href.chat(lead.id)} className="flow-text-action">Talk to {lead.name}<Icon name="chevR" size="sm" /></Link>}</div>
      )}
      {pages.length > 0 && (
        <section className="project-resources">
          <h2 className="flow-section-title">Pages<Link to={href.pages(project.id)} className="flow-text-action" data-testid="all-pages">All Pages<Icon name="chevR" size="xs" /></Link></h2>
          <ul>{pages.map((page) => <PageLine key={page.ref} page={page} now={now} />)}</ul>
        </section>
      )}
      {artifacts.length > 0 && <div className="project-artifacts"><Artifacts artifacts={artifacts} world={world} now={now} open={mac} /></div>}
    </article>
  );
}

function ProjectRow({ project, world, rows, waitingByLane, now }: { project: Project; world: World; rows: LaneRow[]; waitingByLane: Map<string, number>; now: number }) {
  const lanes = rows.filter((row) => row.lane.projectId === project.id);
  const waiting = lanes.reduce((sum, row) => sum + (waitingByLane.get(row.lane.id) ?? 0), 0);
  const fresh = projectNewCount(world.lanes, project.id, world.bots);
  const lead = world.bots.find((bot) => bot.name === project.lead);
  return (
    <li>
      <Link to={href.projects(project.id)} className="project-list-row" data-testid="project-row">
        <span className="project-list-name"><span className="project-letter" aria-hidden="true">{project.name.charAt(0)}</span><span><b>{project.name}</b><span className="project-list-description">{project.description}</span></span></span>
        <span className="project-list-lead"><Avatar name={project.lead} color={lead?.color} size="sm" /><span>Lead {project.lead}</span></span>
        <span className="project-list-work"><b>{waiting} Task Cards</b><span>{lanes.length} Lanes</span></span>
        <span className="project-list-updated"><time>{whenText(project.activeAt, now)}</time>{fresh > 0 && <NewMark count={fresh} testId="project-new" />}</span>
        <Icon name="chevR" size="sm" className="project-list-chevron" />
      </Link>
    </li>
  );
}

function ProjectLoading() {
  return (
    <div className="project-loading" role="status" aria-label="Loading project" data-testid="project-loading">
      <div className="loading-intro"><span className="loading-kicker" /><span className="loading-title" /><span className="loading-description" /><span className="loading-meta" /><span className="loading-tasks" /></div>
      <div className="loading-group"><span className="loading-heading" /><LoadingBars rows={2} height={120} /></div>
      <div className="loading-group"><span className="loading-heading" /><LoadingBars rows={1} height={120} /></div>
    </div>
  );
}

export function ProjectsScreen({ projectId: requestedProjectId, wide, mac, laneId, pane }: { projectId: string | null; wide: boolean; mac: boolean; laneId?: string; pane?: ReactNode }) {
  const qd = useQd();
  const { world, failed, retry } = useWorld();
  const { trackers, failed: trackersFailed, retry: retryTrackers } = useTrackers();
  const chats = useChatRows();
  const now = qd.now();
  const [query, setQuery] = useState<ProjectQuery>(EMPTY_PROJECT_QUERY);
  const [sorting, setSorting] = useState(false);
  const projectId = laneId ? world?.lanes.find((lane) => lane.id === laneId)?.projectId ?? null : requestedProjectId;
  const waitingByLane = useMemo(() => {
    const counts = new Map<string, number>();
    if (world) for (const row of rankQueue(world.cards, world.tasks, now)) counts.set(row.card.laneId, (counts.get(row.card.laneId) ?? 0) + 1);
    return counts;
  }, [world, now]);
  const rows = useMemo(() => (world && (trackers || trackersFailed) ? resolveLanes(world.lanes, trackers ?? {}, world.cards) : null), [world, trackers, trackersFailed]);
  const news = !!world && anyNew(world.lanes, world.bots) || !!chats.value?.some((row) => row.unread);
  const project = world?.projects.find((item) => item.id === projectId);
  const crumb = projectId ? [{ label: "Projects", to: href.projects() }, { label: project?.name ?? "Project", to: laneId ? href.projects(projectId) : undefined }] : undefined;
  const head = <FlowHead title="Projects" crumb={crumb} news={news} />;
  const detail = project && world && rows ? <ProjectDetail project={project} world={world} rows={rows} now={now} waitingByLane={waitingByLane} selectedLane={laneId} mac={mac} /> : null;
  const beside = wide && detail !== null;
  if (laneId) return <div className="lane-workspace">{beside && <div className="lane-project-context"><div className="projects-screen" data-testid="projects">{head}<div className="projects-body">{detail}</div></div></div>}<div className="lane-inspector"><HeadMenuProvider value={!beside}>{pane}</HeadMenuProvider></div></div>;

  if (!world || !rows) return (
    <div className="projects-screen">{head}<div className="projects-body">{failed ? <ErrorLine onRetry={retry}>Could not load the Projects.</ErrorLine> : <ProjectLoading />}</div></div>
  );

  if (projectId) return (
    <div className="projects-screen" data-testid="projects">{head}<div className="projects-body">
      {detail ?? <Empty>This project is not in the example data.</Empty>}
      {trackersFailed && <ErrorLine onRetry={retryTrackers}>Could not load the Lane trackers.</ErrorLine>}
    </div></div>
  );


  const view = viewProjects({ projects: world.projects, lanes: rows.map((row) => ({ ...row.lane, status: row.status })) }, query);
  const pickFilter = (key: string, value: string | undefined) => setQuery({ ...query, filters: withFilter(query.filters, key as ProjectFilterKey, value) });
  const visibleIds = new Set(view.projects.map((item) => item.id));
  const visibleRows = rows.filter((row) => visibleIds.has(row.lane.projectId));
  const waiting = visibleRows.reduce((sum, row) => sum + (waitingByLane.get(row.lane.id) ?? 0), 0);

  return (
    <div className="projects-screen" data-testid="projects">
      {head}
      <div className="projects-body">
        <div className="projects-list-intro"><h1 className="phone-projects-title">Projects</h1><p className="projects-totals" data-testid="totals">{view.count} projects <span>·</span> {waiting} Task Cards <span>·</span> {visibleRows.length} Lanes</p></div>
        <div className="projects-toolbar">
          <SearchField value={query.text} onText={(text) => setQuery({ ...query, text })} label="Search projects" className="projects-search" />
          <div className="relative"><FilterPick groups={view.groups} count={view.filterCount} value={(key) => query.filters[key as ProjectFilterKey]} onPick={pickFilter} onClear={() => setQuery({ ...query, filters: {} })} wide={wide} /></div>
          <div className="relative">
            <Toggle icon="lane" open={sorting} onClick={() => setSorting(!sorting)} data-testid="sort-btn">Sort<span className="project-sort-label">: {query.sort === "name" ? "Name" : "Last activity"}</span></Toggle>
            {sorting && <Sheet title="Sort" pop={wide ? "sort-menu" : "sort-sheet"} wide={wide} onClose={() => setSorting(false)}><ChoiceGroups groups={[{ key: "sort", title: "Sort", choices: PROJECT_SORTS }]} value={() => query.sort} onPick={(_, value) => setQuery({ ...query, sort: value === "name" ? "name" : "activity" })} any={null} /></Sheet>}
          </div>
        </div>
        {view.chips.length > 0 && <FilterLine chips={view.chips} onRemove={(key) => key === "sort" ? setQuery({ ...query, sort: "activity" }) : pickFilter(key, undefined)} onClear={() => setQuery({ ...EMPTY_PROJECT_QUERY, text: query.text })} />}
        {!trackers && (
          <ErrorLine onRetry={retryTrackers} className="mt-3.5">
            Could not load the Lane trackers.
          </ErrorLine>
        )}
        <div className="project-list-head" aria-hidden="true"><span>Project</span><span>Lead bot</span><span>Work</span><span>Last activity</span><span /></div>
        {view.projects.length ? <ul className="project-list">{view.projects.map((item) => <ProjectRow key={item.id} project={item} world={world} rows={rows} waitingByLane={waitingByLane} now={now} />)}</ul> : <div className="project-empty"><p>No projects match.</p><button type="button" className="flow-text-action" onClick={() => setQuery(EMPTY_PROJECT_QUERY)}>Clear search</button></div>}
      </div>
    </div>
  );
}
