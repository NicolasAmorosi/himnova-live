import { IpcError } from "@shared/ipc/result";

/**
 * A closed set of failure reasons for the slides pipeline. `toIpcError`
 * (shared/ipc/result.ts) preserves `.code` for an IpcError and flattens
 * everything else to "UNKNOWN", so the renderer can tell "this deck has a
 * password" apart from "this file is corrupt" without parsing a message string.
 */
export type SlideErrorCode =
  | "PDF_PASSWORD"
  | "RASTER_FAILED"
  | "SOURCE_MISSING"
  /** No reader could open it, and it is no deck we know: `sniffUnreadableDeck`. */
  | "NOT_A_PRESENTATION"
  /** A deck saved with a password to open it. */
  | "DECK_PASSWORD"
  /** PowerPoint 95 or older. */
  | "DECK_OLD_FORMAT"
  | "CANCELED";

export class SlideError extends IpcError {
  readonly slideCode: SlideErrorCode;

  constructor(code: SlideErrorCode, message: string, cause?: unknown) {
    super({ code, message });
    this.slideCode = code;
    this.name = "SlideError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function isSlideError(error: unknown): error is SlideError {
  return error instanceof SlideError;
}
