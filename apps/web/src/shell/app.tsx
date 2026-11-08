import { Component, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode, type RefObject } from "react";
import { useChatRows } from "../data/chat-hooks";
import { useQd, useSignIn } from "../data/hooks";
import { href, parseRoute, type Route } from "../domain/routes";
import { loadMotion } from "../platform/motion-load";
import { QueueScreen } from "../screens/queue/queue";
import { IconButton } from "../ui/button";
import { FrameProvider, Head } from "../ui/head";
import { isTyping } from "../ui/keys";
import { arrive, go, usePath } from "../ui/link";
import { anyOverlayOpen, useOverlay } from "../ui/overlay";
import { ErrorLine, LoadingBars } from "../ui/states";
import { SidebarFailed, SidebarWaiting } from "./sidebar-frame";
import { useSize, type Size } from "./size";

const retries: (() => void)[] = [];

function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const start = () => lazy(() => load().then((component) => ({ default: component })));
  let Loaded = start();
  retries.push(() => {
    Loaded = start();
  });
  return function Screen(props: P) {
    return <Loaded {...(props as P & object)} />;
  };
}

const loadTaskCard = () => import("../screens/task-card/task-card");
const loadSidebar = () => import("./sidebar");
const Sidebar = lazyScreen(() => loadSidebar().then((m) => m.Sidebar));
const TaskCardScreen = lazyScreen(() => loadTaskCard().then((m) => m.TaskCardScreen));
const LaneScreen = lazyScreen(() => import("../screens/lane/lane").then((m) => m.LaneScreen));
const ProjectsScreen = lazyScreen(() => import("../screens/projects/projects").then((m) => m.ProjectsScreen));
const PagesScreen = lazyScreen(() => import("../screens/pages/pages").then((m) => m.PagesScreen));
const PageScreen = lazyScreen(() => import("../screens/page/page").then((m) => m.PageScreen));
const ArtifactScreen = lazyScreen(() => import("../screens/artifact-view/artifact-view").then((m) => m.ArtifactScreen));
const ChatScreen = lazyScreen(() => import("../screens/chat/chat").then((m) => m.ChatScreen));
const MailScreen = lazyScreen(() => import("../screens/mail/mail").then((m) => m.MailScreen));
const SearchDialog = lazyScreen(() => import("./search").then((m) => m.SearchDialog));
const SettingsScreen = lazyScreen(() => import("../screens/settings/settings").then((m) => m.SettingsScreen));
const AddBotDialog = lazyScreen(() => import("../screens/add-bot/add-bot").then((m) => m.AddBotDialog));
const AccountMenu = lazyScreen(() => import("../screens/settings/account").then((m) => m.AccountMenu));
const SignedOut = lazyScreen(() => import("../screens/settings/account").then((m) => m.SignedOut));

type Overlay = "search" | "add-bot" | "account" | null;

function Waiting() {
  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pt-[76px]" data-motion-wait="">
      <LoadingBars rows={3} height={112} />
    </div>
  );
}

type Guard = { resetKey: string; fallback: ReactNode; children: ReactNode };

class ScreenBoundary extends Component<Guard, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Guard, state: { failed: boolean; key: string }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ScreenFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <Head className="px-2 wide:px-8">{null}</Head>
      <div className="px-4 pt-2 wide:px-8">
        <ErrorLine onRetry={onRetry}>Could not load this screen.</ErrorLine>
      </div>
    </div>
  );
}

function SessionHidden({ name, onRetry }: { name: string; onRetry: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <Head className="px-2 wide:px-8">{null}</Head>
      <div className="px-4 pt-2 wide:px-8">
        <ErrorLine onRetry={onRetry}>{"Your " + name + " is hidden until we can confirm it is still you."}</ErrorLine>
      </div>
    </div>
  );
}

function DialogFailed({ onRetry, onClose, returnTo }: { onRetry: () => void; onClose: () => void; returnTo: RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose, returnTo);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Could not load this screen"
        tabIndex={-1}
        data-pop="dialog-failed"
        className="fixed inset-x-0 top-0 z-50 mx-auto flex w-full max-w-[720px] items-start gap-2 p-4 outline-none"
      >
        <ErrorLine className="min-w-0 flex-1" onRetry={onRetry}>
          Could not load this screen.
        </ErrorLine>
        <IconButton icon="x" label="Close" className="rounded-full border border-line-3 bg-panel" onClick={onClose} />
      </div>
    </>
  );
}

function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useOverlay(box, onClose);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label="Menu" tabIndex={-1} data-pop="drawer" className="fixed inset-y-0 left-0 z-50 w-[min(320px,86vw)] outline-none">
        {children}
      </div>
    </>
  );
}

type SlotProps = Omit<ComponentProps<typeof Sidebar>, "chats"> & { tries: number; onRetry: () => void };

function SidebarSlot({ tries, onRetry, ...props }: SlotProps) {
  const chats = useChatRows();
  return (
    <ScreenBoundary resetKey={String(tries)} fallback={<SidebarFailed onRetry={onRetry} />}>
      <Suspense fallback={<SidebarWaiting />}>
        <Sidebar {...props} chats={chats} />
      </Suspense>
    </ScreenBoundary>
  );
}

function screenFor(route: Route, size: Size, onSignedOut: () => void): ReactNode {
  const wide = size !== "narrow";
  switch (route.name) {
    case "queue":
      if (!wide && route.cardId) return <TaskCardScreen key={route.cardId} cardId={route.cardId} pane={false} />;
      return <QueueScreen cardId={route.cardId} wide={wide} pane={(id, auto, toList) => <TaskCardScreen key={id} cardId={id} pane auto={auto} toList={toList} />} />;
    case "lane":
      return <ProjectsScreen projectId={null} laneId={route.laneId} wide={wide} mac={size === "mac"} pane={<LaneScreen key={route.laneId} laneId={route.laneId} />} />;
    case "projects":
      return <ProjectsScreen projectId={route.projectId} wide={wide} mac={size === "mac"} />;
    case "pages":
      return <PagesScreen key={route.projectId} projectId={route.projectId} wide={wide} />;
    case "page":
      return <PageScreen key={route.ref} projectId={route.projectId} pageRef={route.ref} wide={wide} />;
    case "artifact":
      return <ArtifactScreen key={route.ref} projectId={route.projectId} artifactRef={route.ref} />;
    case "chat":
      return <ChatScreen key={route.botId} botId={route.botId} />;
    case "mail":
      return <MailScreen mailRef={route.ref} wide={wide} />;
    case "settings":
      return <SettingsScreen {...route} wide={wide} onSignedOut={onSignedOut} />;
  }
}

export function App() {
  const path = usePath();
  const route = useMemo(() => parseRoute(path), [path]);
  const size = useSize();
  const [drawer, setDrawer] = useState(false);
  const [tries, setTries] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [signedOut, setSignedOut] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const addBotButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const [from, setFrom] = useState<RefObject<HTMLElement | null> | null>(null);
  const frame = useMemo(() => {
    const openFrom = (next: Overlay) => (opener: RefObject<HTMLElement | null>) => {
      setFrom(opener);
      setOverlay(next);
    };
    const openSettings = () => {
      setDrawer(false);
      setOverlay(null);
      go(href.settings());
    };
    return { openMenu: () => setDrawer(true), menuButton, openSearch: openFrom("search"), openAddBot: openFrom("add-bot"), openSettings };
  }, []);

  useLayoutEffect(() => arrive(menuButton), [path]);

  useEffect(() => {
    history.scrollRestoration = "manual";
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 200));
    idle(() => {
      void loadSidebar();
      void loadTaskCard();
      loadMotion();
    });
  }, []);

  useEffect(() => {
    setDrawer(false);
    setOverlay(null);
  }, [path]);

  useEffect(() => {
    if (size === "mac") setDrawer(false);
  }, [size]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || isTyping(event.target) || anyOverlayOpen()) return;
      event.preventDefault();
      setFrom(null);
      setOverlay("search");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const returnTo = overlay === "add-bot" ? addBotButton : searchButton;
  const openOverlay = (next: Overlay) => {
    setDrawer(false);
    setFrom(null);
    setOverlay(next);
  };
  const sidebar = (inDrawer: boolean) => (
    <SidebarSlot
      tries={tries}
      onRetry={retry}
      route={route}
      drawer={inDrawer}
      onClose={() => setDrawer(false)}
      onSearch={() => openOverlay("search")}
      onSettings={frame.openSettings}
      onAddBot={() => openOverlay("add-bot")}
      onAccount={() => openOverlay("account")}
      account={overlay === "account"}
      searchButton={searchButton}
      addBotButton={addBotButton}
      accountButton={accountButton}
    />
  );
  const retry = () => {
    for (const reload of retries) reload();
    setTries((n) => n + 1);
  };
  const closeOverlay = () => setOverlay(null);
  const back = from ?? (size !== "mac" ? menuButton : undefined);
  const showSignedOut = (out: boolean) => {
    openOverlay(null);
    setSignedOut(out);
  };

  if (__QD_SOURCE__ === "server") {
    const session = useSignIn();
    const qd = useQd();
    if (session.required) return (
      <div id="stage" data-mode={size === "narrow" ? "phone" : size} className="min-h-dvh">
        <Suspense fallback={null}>
          <SignedOut onSignIn={() => qd.startSignIn?.()} />
        </Suspense>
      </div>
    );
    if (session.unconfirmed) return (
      <div id="stage" data-mode={size === "narrow" ? "phone" : size} className="min-h-dvh">
        {session.quiet ? <Waiting /> : route.name === "mail" ? <SessionHidden name="Mail" onRetry={session.refresh} /> : route.name === "chat" ? <SessionHidden name="chat" onRetry={session.refresh} /> : <ScreenFailed onRetry={session.refresh} />}
      </div>
    );
  }

  if (signedOut)
    return (
      <div id="stage" data-mode={size === "narrow" ? "phone" : size} className="min-h-dvh">
        <Suspense fallback={null}>
          <SignedOut onSignIn={() => showSignedOut(false)} />
        </Suspense>
      </div>
    );
  return (
    <FrameProvider value={frame}>
      <div id="stage" data-mode={size === "narrow" ? "phone" : size} className="min-h-dvh mac:grid mac:grid-cols-[280px_minmax(0,1fr)]">
        {size === "mac" && (
          <aside className="sticky top-0 h-dvh" inert={overlay !== null}>
            {sidebar(false)}
          </aside>
        )}
        <main id="main-scroll" className="flex min-h-dvh min-w-0 flex-col" inert={drawer || overlay !== null}>
          <ScreenBoundary resetKey={path + tries} fallback={<ScreenFailed onRetry={retry} />}>
            <Suspense fallback={<Waiting />}>{screenFor(route, size, () => showSignedOut(true))}</Suspense>
          </ScreenBoundary>
        </main>
        {drawer && <Drawer onClose={() => setDrawer(false)}>{sidebar(true)}</Drawer>}
        <ScreenBoundary
          resetKey={String(overlay) + tries}
          fallback={<DialogFailed onRetry={retry} onClose={closeOverlay} returnTo={back ?? returnTo} />}
        >
          <Suspense fallback={null}>
            {overlay === "search" && <SearchDialog onClose={closeOverlay} returnTo={back ?? returnTo} />}
            {overlay === "add-bot" && <AddBotDialog onClose={closeOverlay} returnTo={back ?? addBotButton} />}
            {overlay === "account" && <AccountMenu returnTo={back ?? accountButton} onClose={closeOverlay} onSettings={frame.openSettings} onSignedOut={() => showSignedOut(true)} />}
          </Suspense>
        </ScreenBoundary>
      </div>
    </FrameProvider>
  );
}
