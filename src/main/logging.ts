import fs from "node:fs";
import { format } from "node:util";

/** Past this, a log is rotated onto `<name>.1`. A stack is ~1 KB, so this
 *  holds hundreds of them — and a repeating fault writes one per occurrence,
 *  forever, which is what used to grow `crash.log` without bound. */
const LOG_MAX_BYTES = 1_000_000;

/** Rotation rather than truncation: the entry that matters is almost always
 *  the FIRST one, and a fault that repeats would otherwise erase exactly the
 *  line worth reading. At most two files per log, so the ceiling stays ~2 MB. */
function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < LOG_MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No file yet (the common case), or a rename we cannot do. Either way the
    // append is still worth attempting.
  }
}

/** Appends one timestamped line. Never throws: a logger that throws (a full
 *  disk) would take down whatever it was asked to report. */
export function appendLogLine(file: string, label: string, text: string): void {
  try {
    rotate(file);
    fs.appendFileSync(file, `${new Date().toISOString()} [${label}] ${text}\n`);
  } catch {
    // Nowhere left to say it.
  }
}

/**
 * Copies main's `console.info`/`warn`/`error` into `file` as well.
 *
 * A packaged Windows app has no console, so before this every warning main
 * writes — a file the projector could not read, a deck that would not open —
 * vanished on the church PC, and `crash.log` only
 * ever held the crashes. «Open logs folder» in Settings › About is
 * how an operator hands this over.
 */
export function installMainLog(file: string): void {
  for (const level of ["info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      appendLogLine(file, level, format(...args));
    };
  }
}
