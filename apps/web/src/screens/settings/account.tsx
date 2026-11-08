import { useEffect, useRef, useState, type RefObject } from "react";
import { useQd } from "../../data/hooks";
import { href } from "../../domain/routes";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { go } from "../../ui/link";
import { useOverlay } from "../../ui/overlay";
import { SheetDialog } from "../../ui/sheet-dialog";
import { ErrorLine } from "../../ui/states";

const ITEM = "min-h-11 w-full justify-start border-transparent py-0";

type Opener = RefObject<HTMLElement | null>;

function Menu({ onSettings, onSignOut, onClose, returnTo }: { onSettings: () => void; onSignOut: () => void; onClose: () => void; returnTo: Opener }) {
  const settings = () => {
    onSettings();
    history.replaceState({ ...history.state, opener: returnTo.current?.dataset.testid }, "");
  };
  const box = useRef<HTMLDivElement>(null);
  const [row] = useState(() => returnTo.current?.getBoundingClientRect());
  useOverlay(box, onClose, returnTo);
  return (
    <>
      <link rel="stylesheet" href="/settings.css" precedence="settings" />
      <div className="fixed inset-0 z-50" aria-hidden="true" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-label="Account"
        tabIndex={-1}
        data-pop="account-menu"
        style={row && (row.top < window.innerHeight / 2 ? { left: row.left, top: row.bottom + 8 } : { left: row.left, bottom: window.innerHeight - row.top + 8 })}
        className="fixed z-50 grid w-[320px] gap-1 rounded-panel border border-line-2 bg-control p-1.5 shadow-pop outline-none"
      >
        <Button kind="ghost" className={ITEM} onClick={settings} data-autofocus="" data-testid="account-settings">
          Settings
        </Button>
        <Button kind="ghost" className={ITEM} onClick={onSignOut} data-testid="account-sign-out">
          Sign out
        </Button>
      </div>
    </>
  );
}

export function AccountMenu({ onSettings, onSignedOut, onClose, returnTo }: { onSettings: () => void; onSignedOut: () => void; onClose: () => void; returnTo: Opener }) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <SignOutConfirm onClose={onClose} onSignedOut={onSignedOut} returnTo={returnTo} />
  ) : (
    <Menu onSettings={onSettings} onSignOut={() => setAsking(true)} onClose={onClose} returnTo={returnTo} />
  );
}

export function SignOutConfirm({ onClose, onSignedOut, returnTo }: { onClose: () => void; onSignedOut: () => void; returnTo: Opener }) {
  const qd = useQd();
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const signOut = async () => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    try {
      await qd.signOut();
    } catch {
      busy.current = false;
      setFailed(true);
      return;
    }
    onSignedOut();
  };
  return (
    <SheetDialog label="Sign out of Quarterdeck?" pop="sign-out-confirm" onClose={onClose} returnTo={returnTo}>
      <div className="sheet-body grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-5 pt-5">
        <h2 className="text-title leading-[1.25] font-bold tracking-[-.01em]">Sign out of Quarterdeck?</h2>
        <p className="text-body text-ink-2">Unsent drafts on this device are removed.</p>
        {failed && <ErrorLine>Sign-out did not reach Quarterdeck. Try again.</ErrorLine>}
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Button kind="plain" onClick={onClose} data-autofocus="">
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void signOut()} data-testid="sign-out-btn">
            Sign out
          </Button>
        </div>
      </div>
    </SheetDialog>
  );
}

export function SignedOut({ onSignIn }: { onSignIn: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    go(href.queue(), { replace: true });
    heading.current?.focus();
  }, []);
  const signIn = () => {
    go(href.queue(), { replace: true });
    onSignIn();
  };
  return (
    <main className="signed-out grid min-h-dvh place-items-center bg-page" data-testid="signed-out">
      <link rel="stylesheet" href="/settings.css" precedence="settings" />
      <div className="signed-out-box grid w-full justify-items-center gap-5 text-center">
        <span className="signed-out-mark grid place-items-center rounded-full border border-line-3 bg-panel text-ink-2">
          <Icon name="lock" />
        </span>
        <div className="grid gap-1.5">
          <h1 ref={heading} tabIndex={-1} className="text-screen font-bold tracking-[-.02em] outline-none">
            Signed out
          </h1>
          <p className="text-body text-ink-2">This device only.</p>
        </div>
        <Button kind="primary" block onClick={signIn}>
          Sign in with Google
        </Button>
      </div>
    </main>
  );
}
