/**
 * The control window's running counters. Each hands out numbers that tell things apart: a new video `epoch` is a new
 * element that starts from 0:00, a new message `seq` is announced again on the stage, a new provisional id is a new
 * schedule row. Kept in one object so a page of the window that starts again after a crash goes on from the last
 * numbers (`effects/live-copy.ts`): starting at 0, it would hand out one still on the air (2026-11-15 audit, A30).
 */
export const counters = {
  /** A live video's `epoch` (`lib/actions/playback.ts`). */
  video: 0,
  /** A song theme's video background (`lib/song-output.ts`). */
  songVideo: 0,
  /** A live audio track's `epoch` (`stores/audio.store.ts`). */
  audioTrack: 0,
  /** The stage message's `seq` (`stores/stage.store.ts`). */
  stageMessage: 0,
  /** A schedule row not saved yet, as a negative id (`stores/program.store.ts`). */
  provisionalRow: 0,
};
