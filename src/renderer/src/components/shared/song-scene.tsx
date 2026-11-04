import { cn } from "@renderer/lib/utils";
import { sceneTextCss } from "./scene-text";
import { cssFontFamily, cssSceneBackground, type SceneVerticalAlign } from "@shared/types/scene-style";
import type { ProjectionOutput } from "@shared/types/projection";

export type SongOutput = Extract<ProjectionOutput, { kind: "song" }>;

/** What a slide needs to be drawn — the output minus its identity, so a tile
 *  and the size measurer draw it through this same markup. */
export type SongSlideContent = Pick<SongOutput, "backgroundUrl" | "lines" | "sizeCqw" | "theme">;

const VERTICAL_ALIGN: Record<SceneVerticalAlign, string> = {
  top: "justify-start",
  middle: "justify-center",
  bottom: "justify-end",
};

/**
 * One slide of a song, drawn from its `SongTheme` at the song's ONE size.
 *
 * It measures nothing — unlike `BibleScene`, whose verse shrinks on its own:
 * a song's size is measured once for all of its slides (`fitSongSize`, which
 * draws them through this very component) and travels in the output, so the
 * projector, both monitors and every tile cannot disagree and the letters do
 * not change size between slides. Everything is in `cqw`, margins included,
 * for `OutputView`'s reason. `data-song-stage`/`data-song-block` are what the
 * measurer reads.
 */
export function SongScene({
  content,
  onImageError,
}: {
  content: SongSlideContent;
  onImageError?: ((url: string) => void) | undefined;
}) {
  const { backgroundUrl, lines, sizeCqw, theme } = content;
  const background = cssSceneBackground(theme.background);
  const imageBackground = theme.background.kind === "image" ? theme.background : null;
  const { bottom, left, right, top } = theme.margins;

  return (
    <>
      {background ? <div className="absolute inset-0" style={{ background }} /> : null}

      {imageBackground && backgroundUrl ? (
        <img
          alt=""
          className="absolute inset-0 size-full"
          onError={() => onImageError?.(backgroundUrl)}
          src={backgroundUrl}
          style={{ objectFit: imageBackground.fit }}
        />
      ) : null}

      <div
        className={cn("absolute inset-0 flex flex-col", VERTICAL_ALIGN[theme.verticalAlign])}
        data-song-stage=""
        style={{ padding: `${top}cqw ${right}cqw ${bottom}cqw ${left}cqw` }}
      >
        {/* Clipped like the verse: below the theme's floor, what does not fit
            is cut at the margin, and the editor says so. */}
        <div
          className="max-h-full min-h-0 w-full overflow-hidden"
          data-song-block=""
          style={{
            ...sceneTextCss(theme.text),
            fontSize: `${sizeCqw}cqw`,
            fontFamily: cssFontFamily(theme.fontFamily),
            lineHeight: theme.lineHeight,
            textAlign: theme.textAlign,
          }}
        >
          {lines.map((line, index) => (
            // Positional on purpose: the same words twice are two lines.
            <p key={index}>{line}</p>
          ))}
        </div>
      </div>
    </>
  );
}
