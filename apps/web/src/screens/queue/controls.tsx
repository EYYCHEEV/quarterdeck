import { useState, type RefObject } from "react";
import { EMPTY_QUERY, withFilter, type FilterKey, type QueueQuery, type QueueView, type SortKey } from "../../domain/query";
import { ChoiceGroups } from "../../ui/choices";
import { SearchField } from "../../ui/field";
import { Sheet } from "../../ui/overlay";
import { QueueFilter } from "../../ui/queue-filter";
import { Toggle } from "../../ui/toggle";

export function QueueControls({
  view,
  query,
  setQuery,
  wide,
  search,
  onField,
}: {
  view: QueueView | null;
  query: QueueQuery;
  setQuery: (query: QueueQuery) => void;
  wide: boolean;
  search: RefObject<HTMLInputElement | null>;
  onField: () => void;
}) {
  const [sorting, setSorting] = useState(false);
  const shown = view?.rows.length ?? 0;
  return (
    <div className="flex items-center gap-2">
      <SearchField
        value={query.text}
        onText={(text) => {
          onField();
          setQuery({ ...query, text });
        }}
        label="Search the Queue"
        inputRef={search}
        className="min-w-0 flex-1"
        testId="queue-search"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) event.currentTarget.blur();
        }}
      />
      <div className="relative flex items-center gap-2">
        <QueueFilter
          groups={view?.groups ?? []}
          count={view?.filterCount ?? 0}
          value={(key) => query.filters[key as FilterKey]}
          onPick={(key, value) => setQuery({ ...query, filters: withFilter(query.filters, key as FilterKey, value) })}
          onClear={() => setQuery({ ...EMPTY_QUERY, text: query.text, sort: query.sort })}
          wide={wide}
          disabled={!view}
          resultText={"Show " + shown + (shown === 1 ? " Task Card" : " Task Cards")}
        />
        <Toggle icon="lane" open={sorting} onClick={() => setSorting(!sorting)} disabled={!view} data-testid="sort-btn">
          Sort
        </Toggle>
        {sorting && view && (
          <Sheet title="Sort" menu pop={wide ? "sort-menu" : "sort-sheet"} wide={wide} onClose={() => setSorting(false)}>
            <ChoiceGroups
              groups={[{ key: "sort", title: "Sort", choices: view.sorts }]}
              value={() => query.sort}
              onPick={(_, value) => {
                setQuery({ ...query, sort: (value ?? "ranked") as SortKey });
                setSorting(false);
              }}
              any={null}
            />
          </Sheet>
        )}
      </div>
    </div>
  );
}
