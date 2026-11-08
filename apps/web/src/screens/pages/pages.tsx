import { useState } from "react";
import { useQd, useWorld } from "../../data/hooks";
import { usePagesQuery } from "../../data/session";
import { EMPTY_PAGE_QUERY, PAGE_SORTS, viewPages, type PageFilterKey, type PageRow, type PageSort } from "../../domain/pages";
import { withFilter } from "../../domain/query";
import { href } from "../../domain/routes";
import { Button } from "../../ui/button";
import { ChoiceGroups } from "../../ui/choices";
import { FilterLine } from "../../ui/chip";
import { SearchField } from "../../ui/field";
import { FilterPick } from "../../ui/filter-pick";
import { DocumentStyle, DocumentTop } from "../../ui/document";
import { Icon } from "../../ui/icon";
import { Link } from "../../ui/link";
import { Sheet } from "../../ui/overlay";
import { Dot } from "../../ui/row";
import { Empty, ErrorLine, LoadingBars } from "../../ui/states";
import { Toggle } from "../../ui/toggle";

const COLUMNS = ["Title", "Lane", "Made by", "Updated", "Visibility"];

function LiveMark() {
  return (
    <span className="document-mark document-live">
      <Icon name="live" size="xs" />
      Live
    </span>
  );
}

function PublicMark() {
  return <span className="document-mark document-public">Public</span>;
}

function PhoneRow({ row, projectId }: { row: PageRow; projectId: string }) {
  return (
    <li>
      <Link to={href.page(projectId, row.ref)} className="document-phone-row" data-testid="page-row" data-id={row.ref}>
        <span className="document-page-icon"><Icon name="page" /></span>
        <span className="document-title-copy">
          <b>{row.title}</b>
          <span className="document-phone-meta">
            {row.meta.map((part, n) => (
              <span key={n} className="inline-flex items-center gap-x-1.5">
                {n > 0 && <Dot />}
                {part}
              </span>
            ))}
          </span>
          <span className="document-phone-marks">
            {row.live && <LiveMark />}
            {row.visibility === "Public" && <PublicMark />}
          </span>
        </span>
        <Icon name="chevR" size="sm" className="mt-1 text-ink-2" />
      </Link>
    </li>
  );
}

function PhoneList({ rows, pinned, projectId }: { rows: PageRow[]; pinned: number; projectId: string }) {
  const first = rows.slice(0, pinned);
  const rest = rows.slice(pinned);
  return (
    <div className="document-phone-list" data-testid="pages-list">
      {first.length > 0 && (
        <section aria-label="Pinned">
          <h2><Icon name="pin" size="xs" />Pinned</h2>
          <ul>
            {first.map((row) => (
              <PhoneRow key={row.ref} row={row} projectId={projectId} />
            ))}
          </ul>
        </section>
      )}
      {rest.length > 0 && (
        <ul>
          {rest.map((row) => (
            <PhoneRow key={row.ref} row={row} projectId={projectId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TableRow({ row, projectId }: { row: PageRow; projectId: string }) {
  return (
    <tr data-testid="page-row" data-id={row.ref}>
      <td>
        <span className="flex flex-wrap items-center gap-x-3">
          <Link to={href.page(projectId, row.ref)} className="document-title-link">
            <span className="document-page-icon"><Icon name="page" /></span>
            <span className="document-title-copy">{row.title}<small>{row.ref}</small></span>
          </Link>
          {row.live && <LiveMark />}
        </span>
      </td>
      <td className="py-1 pr-3 text-ink-2 [overflow-wrap:anywhere]">{row.lane ?? "(no Lane)"}</td>
      <td className="py-1 pr-3 text-ink-2">{row.by}</td>
      <td className="py-1 pr-3 whitespace-nowrap text-ink-2">{row.updated}</td>
      <td className="py-1 text-ink-2">{row.visibility}</td>
    </tr>
  );
}

function Table({ rows, pinned, projectId }: { rows: PageRow[]; pinned: number; projectId: string }) {
  return (
    <table className="document-table" data-testid="pages-table">
      <thead>
        <tr className="text-tag text-ink-2">
          {COLUMNS.map((name) => (
            <th key={name} scope="col" className="pt-2 pr-3 pb-1.5 font-normal">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      {pinned > 0 && (
        <tbody>
          <tr>
            <th scope="colgroup" colSpan={COLUMNS.length} className="document-pin-heading">
              <span className="inline-flex items-center gap-2"><Icon name="pin" size="xs" />Pinned</span>
            </th>
          </tr>
          {rows.slice(0, pinned).map((row) => (
            <TableRow key={row.ref} row={row} projectId={projectId} />
          ))}
        </tbody>
      )}
      <tbody>
        {rows.slice(pinned).map((row) => (
          <TableRow key={row.ref} row={row} projectId={projectId} />
        ))}
      </tbody>
    </table>
  );
}

export function PagesScreen({ projectId, wide }: { projectId: string; wide: boolean }) {
  const qd = useQd();
  const { world, failed, retry } = useWorld();
  const [query, setQuery] = usePagesQuery(projectId, EMPTY_PAGE_QUERY);
  const [sorting, setSorting] = useState(false);
  const project = world?.projects.find((item) => item.id === projectId) ?? null;

  const head = (
    <>
      <DocumentStyle />
      <DocumentTop to={href.projects(projectId)} label={project?.name ?? "Projects"} screen="Pages" />
    </>
  );
  if (!world || !project)
    return (
      <div className="document-surface">
        {head}
        <div className="px-4 pt-2 wide:px-8">
          {failed ? <ErrorLine onRetry={retry}>Could not load the Pages.</ErrorLine> : world ? <Empty>This project is not in the example data.</Empty> : <LoadingBars rows={3} height={80} />}
        </div>
      </div>
    );

  const view = viewPages(world, projectId, query, qd.now());
  const pickFilter = (key: string, value: string | undefined) => setQuery({ ...query, filters: withFilter(query.filters, key as PageFilterKey, value) });
  const clear = () => setQuery({ ...EMPTY_PAGE_QUERY, text: query.text });
  const sortTo = (value: string): PageSort => (value === "added" ? "added" : value === "title" ? "title" : "updated");

  return (
    <div className="document-surface" data-testid="pages">
      {head}
      <div className="document-body">
        <div className="document-heading">
          <div>
            <p className="document-kicker"><Icon name="projects" size="sm" />{project.name}</p>
            <h1>Pages</h1>
            <p className="document-heading-note" data-testid="pages-sub">{view.line}</p>
          </div>
        </div>
        <div className="document-controls">
          <SearchField value={query.text} onText={(text) => setQuery({ ...query, text })} label="Search pages" className="min-w-0 flex-[1_1_200px] wide:max-w-[420px]" />
          <div className="relative">
            <FilterPick groups={view.groups} count={view.filterCount} value={(key) => query.filters[key as PageFilterKey]} onPick={pickFilter} onClear={() => setQuery({ ...query, filters: {} })} wide={wide} />
          </div>
          <div className="relative">
            <Toggle icon="lane" open={sorting} onClick={() => setSorting(!sorting)} data-testid="sort-btn">
              Sort
            </Toggle>
            {sorting && (
              <Sheet title="Sort" pop={wide ? "sort-menu" : "sort-sheet"} wide={wide} onClose={() => setSorting(false)}>
                <ChoiceGroups groups={[{ key: "sort", title: "Sort", choices: PAGE_SORTS }]} value={() => query.sort} onPick={(_, value) => setQuery({ ...query, sort: sortTo(value ?? "") })} any={null} />
              </Sheet>
            )}
          </div>
        </div>
        {view.chips.length > 0 && <FilterLine chips={view.chips} onRemove={(key) => (key === "sort" ? setQuery({ ...query, sort: "updated" }) : pickFilter(key, undefined))} onClear={clear} />}
        {view.rows.length ? (
          wide ? (
            <Table rows={view.rows} pinned={view.pinned} projectId={projectId} />
          ) : (
            <PhoneList rows={view.rows} pinned={view.pinned} projectId={projectId} />
          )
        ) : (
          <Empty
            className="mt-3.5"
            action={
              view.total > 0 && (
                <Button kind="ghost" onClick={() => setQuery(EMPTY_PAGE_QUERY)}>
                  Clear search and filters
                </Button>
              )
            }
          >
            {view.total > 0 ? "No Pages match." : "No Pages in this project yet."}
          </Empty>
        )}
      </div>
    </div>
  );
}
