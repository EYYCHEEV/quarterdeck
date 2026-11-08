import { ErrorLine } from "../ui/states";

export const SIDEBAR = "flex h-full flex-col gap-1 overflow-y-auto overscroll-contain border-r border-line bg-side px-2.5 pt-3 pb-3.5";

export function ChatsLoading() {
  return (
    <div className="mt-3 grid gap-2" role="status" aria-label="Loading chats" data-testid="chats-loading">
      <span className="h-16 rounded-control bg-panel" />
      <span className="h-12 rounded-small bg-panel" />
      <span className="h-12 rounded-small bg-panel" />
    </div>
  );
}

export function SidebarWaiting() {
  return (
    <div className={SIDEBAR} data-testid="sidebar-waiting">
      <ChatsLoading />
    </div>
  );
}

export function SidebarFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={SIDEBAR} data-testid="sidebar-failed">
      <ErrorLine className="mt-3" onRetry={onRetry}>
        Could not load the menu.
      </ErrorLine>
    </div>
  );
}
