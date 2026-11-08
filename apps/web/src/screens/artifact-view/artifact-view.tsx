import { Fragment, useState } from "react";
import { useQd, useWorld } from "../../data/hooks";
import { EMPTY_ARTIFACT_QUERY, viewArtifacts, type ArtifactQuery } from "../../domain/projects";
import { href } from "../../domain/routes";
import { whenText } from "../../domain/time";
import { DocumentStyle, DocumentTop } from "../../ui/document";
import { SearchField } from "../../ui/field";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { ReferenceBar } from "../../ui/reference";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";

export function ArtifactScreen({ projectId, artifactRef }: { projectId: string; artifactRef: string }) {
  const qd = useQd();
  const { world, failed, retry } = useWorld();
  const [query, setQuery] = useState<ArtifactQuery>(EMPTY_ARTIFACT_QUERY);
  const artifact = world?.artifacts.find((item) => item.ref === artifactRef && item.projectId === projectId) ?? null;
  const project = world?.projects.find((item) => item.id === projectId) ?? null;
  const head = (
    <>
      <DocumentStyle />
      <DocumentTop to={href.projects(projectId)} label={project?.name ?? "Projects"} screen="Artifact" />
    </>
  );
  if (!world || !artifact)
    return (
      <div className="document-surface">
        {head}
        <div className="document-body">
          {failed ? <ErrorLine onRetry={retry}>Could not load this Artifact.</ErrorLine> : world ? <Empty>This Artifact is not in the example data.</Empty> : <LoadingBars rows={1} height={320} />}
        </div>
      </div>
    );
  const artifacts = viewArtifacts(world.artifacts.filter((item) => item.projectId === projectId), query);
  const kind = artifact.kind.charAt(0).toUpperCase() + artifact.kind.slice(1);
  const users = [
    ...artifact.laneIds.map((id) => ({ to: href.lane(id), name: world.lanes.find((item) => item.id === id)?.name ?? id })),
    ...artifact.cardIds.map((id) => ({ to: href.queue(id), name: world.cards.find((item) => item.id === id)?.title ?? id })),
  ];
  return (
    <div className="document-surface" data-testid="artifact-viewer">
      {head}
      <div className="document-body">
        <div className="document-heading">
          <div>
            <p className="document-kicker"><Icon name="projects" size="sm" />{project?.name ?? "Project"}</p>
            <h1>Artifacts</h1>
            <p className="document-heading-note">Working files · read-only</p>
          </div>
          <span className="document-count">{artifacts.count}</span>
        </div>
        <div className="document-artifacts">
          <section className="document-artifact-list" aria-label="Artifacts">
            <h2>Files</h2>
            <div className="document-artifact-controls">
              <SearchField label="Search artifacts" value={query.text} onText={(text) => setQuery({ ...query, text })} />
              <select aria-label="Artifact kind" value={query.kind} onChange={(event) => setQuery({ ...query, kind: event.target.value })}>
                <option value="">Kind: All</option>
                {artifacts.kinds.map((value) => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}
              </select>
            </div>
            <ul>
              {artifacts.artifacts.map((item) => {
                const used = [...item.laneIds.map((id) => world.lanes.find((lane) => lane.id === id)?.name ?? id), ...item.cardIds.map((id) => world.cards.find((card) => card.id === id)?.title ?? id)];
                return (
                  <li key={item.ref}>
                    <Link to={href.artifact(projectId, item.ref)} className="document-artifact-row" aria-current={item.ref === artifact.ref ? "page" : undefined} data-testid="artifact-row">
                      <b>{item.name}</b>
                      <small>{item.kind} · {item.size} · {item.by} · {whenText(item.addedAt, qd.now())}</small>
                      <small>Used by: {used.join(", ") || "No references yet"}</small>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {!artifacts.artifacts.length && <p className="text-meta text-ink-2">No artifacts match.</p>}
          </section>
          <section className="document-artifact-reader" aria-label="Open Artifact">
            <h2>{artifact.name}</h2>
            <p className="mt-2 text-meta text-ink-2">{kind} · {artifact.size} · {artifact.by} · {whenText(artifact.addedAt, qd.now())}</p>
            <ReferenceBar code={artifact.ref} readOnly className="mt-2" />
            <dl>
              <div className="flex flex-wrap gap-x-1.5">
                <dt className="text-ink-2">Stored in:</dt>
                <dd className="m-0 [overflow-wrap:anywhere]">{artifact.storage}</dd>
              </div>
              {users.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-1.5">
                  <dt className="text-ink-2">Used by:</dt>
                  <dd className="m-0 flex flex-wrap items-center gap-x-1.5">
                    {users.map((user, n) => (
                      <Fragment key={user.to}>
                        {n > 0 && <span className="text-ink-2">·</span>}
                        <Link to={user.to} className="inline-flex min-h-11 items-center text-link hover:underline">{user.name}</Link>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
            <div className="document-file" data-testid="artifact-box">
              <div><span className="inline-flex items-center gap-2"><Icon name="terminal" size="xs" />{artifact.ref}</span><span>Read-only</span></div>
              <pre tabIndex={0} aria-label={artifact.name}>{artifact.text}</pre>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
