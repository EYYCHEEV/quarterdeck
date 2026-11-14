import { ErrorLine } from "../ui/states";

export const SIDEBAR = "flex h-full flex-col gap-s1 overflow-y-auto overscroll-contain border-r border-line bg-side px-s2 pt-s3 pb-s3";

export function ChatsLoading() {
  return (
    <div className="mt-s3 grid gap-s2" role="status" aria-label="Loading chats" data-testid="chats-loading">
      <span className="h-[64px] rounded-key bg-panel" />
      <span className="h-s7 rounded-key bg-panel" />
      <span className="h-s7 rounded-key bg-panel" />
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
      <ErrorLine className="mt-s3" onRetry={onRetry}>
        Could not load the menu.
      </ErrorLine>
    </div>
  );
}
