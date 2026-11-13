/** Where a copy of the database came from: the daily one (or one made by hand), the one before an update's
 *  migrations, the one of what a restore replaced, or a file the operator picked anywhere else. */
export type BackupKind = "daily" | "update" | "restore" | "file";

export type BackupEntry = {
  path: string;
  kind: BackupKind;
  /** When it was taken: the file's modification time. */
  takenAt: number;
  sizeBytes: number;
  /** What it holds, to choose by; `null` when it cannot be read (or a schema without that table). */
  programs: number | null;
  songs: number | null;
};

/** What the restore asked for before the last restart did, said once in the control window. */
export type LaunchRestore = { status: "ok"; takenAt: number } | { status: "failed"; reason: string };
