/** Stable, so the control window can word it: the text is the renderer's. */
export type UpdateErrorCode = "offline" | "notPublished" | "checksum" | "install" | "unknown";

export type UpdateStep = "check" | "download" | "install";

/**
 * Where the in-app update stands. Main owns it (`main/updates/updater.ts`) and
 * pushes every change as `update-status`; the control window only asks for it
 * and listens.
 *
 * `unsupported` is a build that cannot update itself: `npm run dev`, an
 * AppImage started without `APPIMAGE`, a snap. Settings says so and offers
 * nothing.
 */
export type UpdateStatus =
  | { kind: "unsupported" }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate"; checkedAt: number }
  | { kind: "available"; version: string }
  /** Bytes so far and in all; `total` is 0 until the server has said. */
  | { kind: "downloading"; version: string; percent: number; transferred: number; total: number }
  /** `installOnQuit`: the operator chose «When the app closes».
   *  `opensInstaller`: installing opens the `.dmg` for the operator to drag
   *  over the app (macOS without a Developer ID) instead of replacing it and
   *  reopening on its own. */
  | { kind: "downloaded"; version: string; installOnQuit: boolean; opensInstaller: boolean }
  | { kind: "error"; code: UpdateErrorCode; during: UpdateStep };

/** A check never starts over one in flight, and never undoes a download.
 *  Main enforces it; the control window greys «Check for updates» with it. */
export function canCheck(status: UpdateStatus): boolean {
  return !["unsupported", "checking", "downloading", "downloaded"].includes(status.kind);
}
