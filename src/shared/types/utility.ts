/**
 * A utility scene: one saved, reusable, projectable piece of time.
 *
 * The operator builds "10-minute countdown" once (with its background, its
 * typeface, its colour and its message) and picks it off a list every service
 * after that. From F2 on this is a row in `utility_scenes`; the shape is
 * identical either way, which is what lets F1 ship the whole feature against
 * the built-in defaults below without anything having to be rewritten.
 */
import { DEFAULT_SCENE_STYLE, type SceneStyle } from "./scene-style";
import { DEFAULT_TIMER_FORMAT, type TimerConfig, type TimerTool } from "./timer";

export type UtilityScene = {
  id: number;
  /** What the operator called it. Free text, shown in the list. */
  name: string;
  tool: TimerTool;
  config: TimerConfig;
  style: SceneStyle;
  /** The line above the number. `null` hides it. */
  title: string | null;
  /** The line below it — replaced by `config.endMessage` once a countdown
   *  passes zero. */
  message: string | null;
};

/** Only the fields the editor can change; `id` distinguishes an update from a
 *  create, exactly like `ProgramUpsert`. */
export type UtilitySceneUpsert = Omit<UtilityScene, "id"> & { id?: number };

/** Which saved programs reference a scene, for the "delete anyway"
 *  confirmation — the FK violation itself does not say which program. Same
 *  shape and same purpose as `MediaAssetUsage`. */
export type UtilitySceneUsage = {
  programId: number;
  programName: string;
  itemCount: number;
};

const MINUTE_MS = 60_000;

/**
 * The four scenes a fresh install starts with — one per tool, so the feature
 * is usable before anybody opens the editor.
 *
 * Their texts are SEED CONTENT, not UI text: they land in a row the operator
 * renames and edits like any program name, so they are written once, in the
 * language of the first launch (main's dictionary, `seed.*`), and never follow
 * a later change of language.
 *
 * No ids: these are an INPUT to the seed (`db/seed/seed-utility-scenes.ts`),
 * which runs once ever and hands out real row ids. Seeding again whenever the
 * table happens to be empty would mean an operator can never be rid of a scene
 * they deleted — so "was this database seeded" is its own flag
 * (`utility.seeded`), not a row count.
 */
export type DefaultSceneTexts = {
  countdownName: string;
  countdownTitle: string;
  countdownToTimeName: string;
  countdownToTimeTitle: string;
  clockName: string;
  stopwatchName: string;
  endMessage: string;
};

export function defaultUtilityScenes(text: DefaultSceneTexts): Omit<UtilityScene, "id">[] {
  return [
    {
      name: text.countdownName,
      tool: "countdown",
      config: {
        durationMs: 10 * MINUTE_MS,
        targetMinuteOfDay: 10 * 60,
        endMessage: text.endMessage,
        format: DEFAULT_TIMER_FORMAT,
      },
      style: DEFAULT_SCENE_STYLE,
      title: text.countdownTitle,
      message: null,
    },
    {
      name: text.countdownToTimeName,
      tool: "countdown-to-time",
      config: {
        durationMs: 10 * MINUTE_MS,
        targetMinuteOfDay: 10 * 60,
        endMessage: text.endMessage,
        format: DEFAULT_TIMER_FORMAT,
      },
      style: DEFAULT_SCENE_STYLE,
      title: text.countdownToTimeTitle,
      message: null,
    },
    {
      name: text.clockName,
      tool: "clock",
      config: {
        durationMs: 10 * MINUTE_MS,
        targetMinuteOfDay: 10 * 60,
        endMessage: null,
        format: { ...DEFAULT_TIMER_FORMAT, showSeconds: false },
      },
      style: DEFAULT_SCENE_STYLE,
      title: null,
      message: null,
    },
    {
      name: text.stopwatchName,
      tool: "stopwatch",
      config: {
        durationMs: 10 * MINUTE_MS,
        targetMinuteOfDay: 10 * 60,
        endMessage: null,
        format: DEFAULT_TIMER_FORMAT,
      },
      style: DEFAULT_SCENE_STYLE,
      title: null,
      message: null,
    },
  ];
}
