import { useState, type ReactNode } from "react";
import { ErrorBoundary } from "./error-boundary";

type ModalBoundaryProps = {
  children: ReactNode;
  /** Whether the modal inside is currently open. Each OPENING remounts the
   *  boundary: one that has caught stays caught, so without a fresh one the
   *  modal would be dead for the rest of the session. Closing already happens
   *  on every crash (that is what `onCrash` is for), so the next open always
   *  gets a fresh attempt. Not on closing: a full-screen editor stays mounted
   *  for its fade-out (`Modal`), and a remount there cut it off. */
  open: boolean;
  /** Close this modal and tell the operator. Runs in the commit phase — see
   *  `ErrorBoundary.onError`. */
  onCrash: (error: Error) => void;
};

/**
 * The control window's modals get their own boundary each, not a share of the
 * shell's.
 *
 * The shell boundary replaces what it wraps with a full-panel failure screen.
 * That is the right answer for the workspace itself, and the wrong one for a
 * modal: a throw while rendering the settings dialog would take the order of
 * service, the monitors and every live control down with it, mid-service,
 * over a window the operator opened for ten seconds. Here the modal simply
 * disappears — with a toast saying so — and the shell behind it never notices.
 *
 * The fallback renders nothing on purpose. A modal that failed to render has
 * no partial state worth showing, and `onCrash` has already closed it; an
 * inline error panel would just be a second dead dialog to dismiss.
 */
export function ModalBoundary({ children, onCrash, open }: ModalBoundaryProps) {
  const [opens, setOpens] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpens((n) => n + 1);
  }
  return (
    <ErrorBoundary fallback={() => null} key={opens} onError={onCrash}>
      {children}
    </ErrorBoundary>
  );
}
