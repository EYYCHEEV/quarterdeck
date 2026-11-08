import { createContext, Fragment, useContext, useRef, useState } from "react";
import { FloatAction, FloatCapsule, FloatListTop, FloatTop } from "./float";
import { FloatBack } from "./float-back";
import { Head, Title, useFrame } from "./head";
import { Icon } from "./icon";
import { Link } from "./link";
import { MoreSheet } from "./more-sheet";
import { usePhone } from "./phone";

type Crumb = { label: string; to?: string };

const HeadMenu = createContext(true);

export const HeadMenuProvider = HeadMenu.Provider;

function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0" data-testid="crumb">
      <ol className="flex min-h-11 min-w-0 items-center gap-1 text-note font-semibold">
        {items.map((item, index) => (
          <Fragment key={item.label + index}>
            {index > 0 && <li aria-hidden="true" className="flex-none text-ink-3"><Icon name="chevR" size="sm" /></li>}
            <li className="flex min-w-0">
              {item.to ? (
                <Link to={item.to} className="flex min-h-11 min-w-0 items-center rounded-small px-1 text-ink-2 hover:bg-control hover:text-ink">
                  <span className="truncate">{item.label}</span>
                </Link>
              ) : (
                <span aria-current="page" className="truncate px-1 text-ink">{item.label}</span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

function BackTop({ to, label, actions }: { to: string; label: string; actions: string }) {
  const frame = useFrame();
  const search = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!frame) return null;
  return (
    <>
      <FloatTop>
        <FloatBack to={to} label={"Back to " + label} />
        <FloatCapsule label={actions}>
          <FloatAction ref={search} glyph="search" label="Search" onClick={() => frame.openSearch(search)} />
          <FloatAction ref={more} glyph="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
        </FloatCapsule>
      </FloatTop>
      {open && (
        <MoreSheet
          items={[
            ...(__QD_SOURCE__ === "server" ? [] : [{ icon: "plus", label: "Add bot", onPick: frame.openAddBot } as const]),
            { icon: "settings", label: "Settings", onPick: frame.openSettings },
          ]}
          from={more}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function FlowHead({ title, crumb, news = false }: { title: string; crumb?: Crumb[]; news?: boolean }) {
  const back = crumb?.filter((item): item is Required<Crumb> => item.to !== undefined).at(-1);
  const phone = usePhone();
  const menu = useContext(HeadMenu);
  return (
    <>
      <link rel="stylesheet" href="/lanes.css" precedence="lanes" />
      {!phone && (
        <div className="flow-desktop-head">
          <Head menu={menu} className="px-2 wide:px-8">
            {crumb ? <Crumbs items={crumb} /> : <Title>{title}</Title>}
          </Head>
        </div>
      )}
      {phone && (back ? <BackTop to={back.to} label={back.label} actions={title + " actions"} /> : <FloatListTop label={title + " actions"} dot={news} />)}
    </>
  );
}
