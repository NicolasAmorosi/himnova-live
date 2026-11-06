import { useEffect, useRef } from "react";

/**
 * Runs the LATEST `commit` when the component unmounts — for a field that
 * saves on blur or Enter in a screen that applies at once (Settings). Escape
 * closes the screen without moving the focus, so the field is unmounted with
 * no blur (and React delivers no event during a commit anyway): the typed value
 * was simply dropped. `commit` runs on every unmount, so it must do nothing
 * when the value did not change.
 */
export function useCommitOnUnmount(commit: () => void): void {
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
}
