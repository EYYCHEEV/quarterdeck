import type { ReactNode, RefObject } from "react";
import type { FloatMoreItem } from "./float";
import { Icon } from "./icon";
import { Sheet } from "./overlay";

export const MENU_ROW = "flex min-h-s7 w-full cursor-pointer items-center gap-s3 rounded-key px-s3 text-left text-body font-strong hover:bg-raised";

export function MoreSheet({ items, from, onClose, children }: { items: FloatMoreItem[]; from: RefObject<HTMLElement | null>; onClose: () => void; children?: ReactNode }) {
  return (
    <Sheet title="More" wide={false} onClose={onClose} pop="more">
      {children}
      <ul className="grid gap-hair pb-s1">
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              onClick={() => {
                onClose();
                item.onPick(from);
              }}
              className={MENU_ROW}
              data-testid="more-item"
            >
              <Icon name={item.icon} className="text-ink-2" />
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
