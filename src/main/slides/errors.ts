import { IpcError } from "@shared/ipc/result";
import { mt } from "../i18n";

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
  /** The file's disk or share did not answer its `stat` in time: nothing is said of the file. */
  | "SOURCE_NOT_RESPONDING"
  /** No reader could open it, and it is no deck we know: `sniffUnreadableDeck`. */
  | "NOT_A_PRESENTATION"
  /** A deck saved with a password to open it. */
  | "DECK_PASSWORD"
  /** PowerPoint 95 or older. */
  | "DECK_OLD_FORMAT"
  /** The deck worker's clock stopped it: reading it, or copying its clips, went too long without progress. */
  | "DECK_TOO_SLOW"
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

/** The rasterizer window's failure, in the operator's words: pdf.js's own message («Invalid PDF structure.», a fetch's
 *  status) is English prose, kept for the log only (2026-11-22, EC-1). */
export function rasterReplyError(error: { kind: "password" | "unknown"; message: string }): SlideError {
  if (error.kind === "password") return new SlideError("PDF_PASSWORD", mt("slides.pdfPassword"));
  console.warn("[slides] the PDF could not be drawn:", error.message);
  return new SlideError("RASTER_FAILED", mt("slides.pdfUnreadable"));
}
