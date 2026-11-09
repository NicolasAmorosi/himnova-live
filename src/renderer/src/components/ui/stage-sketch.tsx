import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";
import { Icon, type IconName } from "./icon";

/** What was on the projector before, coloured like its kind is everywhere else (the schedule's badges). */
export type SketchContent = "video" | "ppt" | "song" | "audio";

// Dimmed over the black stage: a card is a reminder of the kind, not a swatch of it.
const tints: Record<SketchContent, string> = {
  video: "bg-badge-video/40",
  ppt: "bg-badge-ppt/40",
  song: "bg-section-verse/45",
  audio: "bg-badge-audio/40",
};

const contentIcons: Record<SketchContent, IconName> = { video: "video", ppt: "ppt", song: "song", audio: "audio" };

/** The «after» drawn on the stage: the kind's own tile, black, or a mark of the app. */
export type SketchScene = { kind: "content"; content: SketchContent } | { kind: "black" } | { kind: "logo" };

type StageSketchProps = {
  className?: string;
  /** Plays «before» — `content` on the stage, its progress filling — and fades into `after`, over and over;
   *  the chosen card's only (one moving thing at a time). Still: `after` alone. */
  animate?: boolean;
  after: SketchScene;
  /** A sign over `after` that names the choice: ↻ for «loop», ‖ for «hold»… */
  badge?: IconName | undefined;
  content: SketchContent;
  /** The church's name, which a «logo» scene shows when it has one; else the app's flame. */
  logo?: ReactNode;
};

/**
 * A tiny picture of the projector: what happens when something ends. Always black like the real stage in
 * both themes (as `Monitor`'s), so its marks are light in both.
 */
export function StageSketch({ after, animate = false, badge, className, content, logo }: StageSketchProps) {
  return (
    <div className={cn("relative aspect-video w-full overflow-hidden rounded-sm bg-black", className)}>
      <SketchLayer content={content} logo={logo} scene={after} />
      {badge ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
            <Icon className="size-3.5" name={badge} />
          </span>
        </span>
      ) : null}
      {animate ? (
        <div className="wa-sketch-before absolute inset-0 bg-black">
          <SketchLayer content={content} scene={{ kind: "content", content }} />
          <span className="absolute inset-x-1.5 bottom-1.5 h-0.5 overflow-hidden rounded-full bg-white/25">
            <span className="wa-sketch-progress block h-full w-full rounded-full bg-white/80" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SketchLayer({ content, logo, scene }: { content: SketchContent; logo?: ReactNode; scene: SketchScene }) {
  switch (scene.kind) {
    case "black":
      return null;
    case "logo":
      return (
        <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-2xs font-semibold text-white">
          {logo}
        </span>
      );
    case "content":
      return (
        <span className={cn("absolute inset-0 flex items-center justify-center text-white/90", tints[scene.content])}>
          <Icon className="size-4" name={contentIcons[content]} />
        </span>
      );
  }
}
