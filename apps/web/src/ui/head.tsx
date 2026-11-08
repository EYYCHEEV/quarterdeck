import { createContext, useContext, type ComponentProps, type ReactNode, type RefObject } from "react";
import { IconButton } from "./button";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Link } from "./link";

type Opener = RefObject<HTMLElement | null>;

type Frame = {
  openMenu: () => void;
  menuButton: RefObject<HTMLButtonElement | null>;
  openSearch: (from: Opener) => void;
  openAddBot: (from: Opener) => void;
  openSettings: (from: Opener) => void;
};

export const FrameContext = createContext<Frame | null>(null);

export const FrameProvider = FrameContext.Provider;

export const useFrame = () => useContext(FrameContext);

function MenuButton() {
  const frame = useContext(FrameContext);
  if (!frame) return null;
  return <IconButton ref={frame.menuButton} icon="menu" label="Menu" onClick={frame.openMenu} className="text-ink mac:hidden" data-testid="menu-btn" />;
}

export function Head({ menu = true, className, children }: { menu?: boolean; className?: string; children: ReactNode }) {
  return (
    <header className={cx("flex min-h-15 items-center gap-1.5 pt-[max(8px,env(safe-area-inset-top))]", className)}>
      {menu && <MenuButton />}
      {children}
    </header>
  );
}

export function Title(props: Omit<ComponentProps<"h1">, "className">) {
  return <h1 className="min-w-0 text-screen font-bold tracking-[-.02em] wide:text-screen-wide" {...props} />;
}

export function BackLink({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={cx("inline-flex min-h-11 items-center gap-1 rounded-small pr-2 pl-1 text-note font-semibold whitespace-nowrap text-ink hover:bg-control", className)}
    >
      <Icon name="back" size="sm" />
      {children}
    </Link>
  );
}
