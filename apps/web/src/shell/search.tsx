import { useMemo, useState, type RefObject } from "react";
import { useChatRows } from "../data/chat-hooks";
import { useWorld } from "../data/hooks";
import { href } from "../domain/routes";
import { searchAll, searchSources, type Hit, type SearchGroup } from "../domain/search";
import { Avatar } from "../ui/avatar";
import { SearchField } from "../ui/field";
import { Icon, type IconName } from "../ui/icon";
import { go } from "../ui/link";
import { Dialog, DialogHead } from "../ui/overlay";
import { Empty, ErrorLine, LoadingBars } from "../ui/states";

const ROUTE: Record<SearchGroup, (id: string, projectId: string | null) => string> = {
  Chats: href.chat,
  "Task Cards": href.queue,
  Projects: href.projects,
  Lanes: href.lane,
  Pages: (id, projectId) => href.page(projectId ?? "", id),
  Artifacts: (id, projectId) => href.artifact(projectId ?? "", id),
  Mail: href.mail,
};

const ICON: Record<Exclude<SearchGroup, "Chats">, IconName> = { "Task Cards": "queue", Projects: "projects", Lanes: "lane", Pages: "page", Artifacts: "file", Mail: "mail" };

function HitRow({ hit, color, onOpen }: { hit: Hit; color?: string; onOpen: () => void }) {
  return (
    <li className="min-w-0">
      <button type="button" onClick={onOpen} className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-small px-3 py-1.5 text-left hover:bg-raised" data-testid="search-hit">
        {hit.group === "Chats" ? <Avatar name={hit.title.map((part) => part.text).join("")} color={color} size="sm" /> : <Icon name={ICON[hit.group]} size="sm" className="text-ink-3" />}
        <span className="min-w-0 flex-1">
          <span className="block text-prose [overflow-wrap:anywhere] text-ink-2">
            {hit.title.map((part, n) =>
              part.bold ? (
                <b key={n} className="font-semibold text-ink">
                  {part.text}
                </b>
              ) : (
                <span key={n}>{part.text}</span>
              ),
            )}
          </span>
          <span className="block truncate text-small text-ink-3">{hit.detail}</span>
        </span>
      </button>
    </li>
  );
}

export function SearchDialog({ onClose, returnTo }: { onClose: () => void; returnTo: RefObject<HTMLElement | null> }) {
  const { world, failed, retry } = useWorld();
  const chats = useChatRows();
  const [text, setText] = useState("");
  const [whole, setWhole] = useState<SearchGroup[]>([]);
  const found = useMemo(() => {
    if (!world) return [];
    const people = (chats.value ?? []).map((row) => ({ id: row.bot.id, name: row.bot.name, role: row.bot.role, preview: row.preview }));
    return searchAll(text, searchSources(world, people), whole);
  }, [world, chats.value, text, whole]);
  const type = (next: string) => {
    setText(next);
    setWhole([]);
  };
  const open = (hit: Hit) => {
    onClose();
    go(ROUTE[hit.group](hit.id, hit.projectId));
  };
  return (
    <Dialog label="Search" pop="search" onClose={onClose} returnTo={returnTo}>
      <DialogHead title="Search" onClose={onClose} closeLabel="Close search" />
      <div className="flex-none px-4 pt-3 pb-2">
        <SearchField value={text} onText={type} label="Search everything" testId="search-input" first />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {failed && !world ? (
          <ErrorLine className="mx-2" onRetry={retry}>
            Could not load what to search.
          </ErrorLine>
        ) : !world ? (
          <LoadingBars rows={3} height={64} className="px-2" />
        ) : found.length === 0 ? (
          <Empty className="mx-2">Nothing matches.</Empty>
        ) : (
          found.map((group) => (
            <section key={group.group} className="mt-3" data-testid="search-group" data-group={group.group}>
              <h3 className="eyebrow px-3 pb-1">{group.group}</h3>
              <ul className="grid gap-0.5" data-truncates="">
                {group.hits.map((hit) => (
                  <HitRow key={hit.id} hit={hit} color={hit.group === "Chats" ? world?.bots.find((b) => b.id === hit.id)?.color : undefined} onOpen={() => open(hit)} />
                ))}
              </ul>
              {group.more > 0 && (
                <button
                  type="button"
                  onClick={() => setWhole([...whole, group.group])}
                  className="ml-3 inline-flex min-h-11 cursor-pointer items-center gap-1 text-small font-semibold text-link hover:underline"
                  data-testid="search-more"
                >
                  See all, {group.more} more
                  <Icon name="chevD" size="xs" />
                </button>
              )}
            </section>
          ))
        )}
      </div>
    </Dialog>
  );
}
