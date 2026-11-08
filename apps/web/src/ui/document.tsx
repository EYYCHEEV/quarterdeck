import { useRef, useState, type ReactNode } from "react";
import { FloatAction, FloatCapsule, FloatTop } from "./float";
import { FloatBack } from "./float-back";
import { Head, useFrame } from "./head";
import { Icon } from "./icon";
import { Link } from "./link";
import { MoreSheet } from "./more-sheet";
import { usePhone } from "./phone";
import { DOCUMENT_STYLE } from "./document-style";

type Top = { to: string; label: string; screen: string; tools?: ReactNode; menu?: ReactNode };

export function DocumentStyle() {
  return <style>{DOCUMENT_STYLE}</style>;
}

function PhoneTop({ to, label, screen, tools, menu }: Top) {
  const frame = useFrame();
  const search = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <FloatTop>
        <FloatBack to={to} label={"Back to " + label} />
        {tools ? (
          <FloatCapsule label={screen + " actions"}>{tools}</FloatCapsule>
        ) : (
          frame && (
            <FloatCapsule label={screen + " actions"}>
              <FloatAction ref={search} glyph="search" label="Search" onClick={() => frame.openSearch(search)} />
              <FloatAction ref={more} glyph="more" label="More" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
            </FloatCapsule>
          )
        )}
      </FloatTop>
      {menu}
      {open && frame && (
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

export function DocumentTop(top: Top) {
  const phone = usePhone();
  if (phone) return <PhoneTop {...top} />;
  return (
    <Head menu={false} className="document-top">
      <Link to={top.to} aria-label={"Back to " + top.label} className="document-back">
        <Icon name="back" />
        <span>{top.label}</span>
      </Link>
      {top.tools && (
        <div className="document-tools">
          {top.tools}
          {top.menu}
        </div>
      )}
    </Head>
  );
}
