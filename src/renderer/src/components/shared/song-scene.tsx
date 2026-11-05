import { cn } from "@renderer/lib/utils";
import { sceneTextCss } from "./scene-text";
import { cssFontFamily, cssSceneBackground, type SceneVerticalAlign } from "@shared/types/scene-style";
import type { ProjectionOutput } from "@shared/types/projection";
import { SONG_FOOTER_LINES, type SongChord, type SongTheme } from "@shared/types/song";

export type SongOutput = Extract<ProjectionOutput, { kind: "song" }>;

/** What a slide needs to be drawn — the output minus its identity, so a tile
 *  and the size measurer draw it through this same markup. */
export type SongSlideContent = Pick<SongOutput, "backgroundUrl" | "footer" | "lines" | "sizeCqw" | "theme"> & {
  /** The second language, under the lyrics (`SongTheme.translation`). */
  translation?: readonly string[] | null | undefined;
  /** Only the musicians' screen sends them (`SongOutput.chords`). */
  chords?: readonly (readonly SongChord[])[] | undefined;
};

/** A row of chords over every line makes the block this much taller, so the
 *  words shrink by as much: the song's one size was measured without them. */
const CHORDED_SCALE = 0.66;
/** Amber, the flame's: apart from any theme's text colour, and never
 *  uppercased by one (`Am` is not `AM`). */
const CHORD_STYLE = { color: "#ffc960", fontSize: "0.6em", fontWeight: 700, lineHeight: 1.15, textTransform: "none" } as const;

/** A line with its chords over it: each chord heads the words from its
 *  position to the next one's. Spaces are kept (`pre`) so a cut between
 *  two words keeps the space between them. */
function ChordedLine({ chords, line }: { chords: readonly SongChord[]; line: string }) {
  if (chords.length === 0) return <p>{line}</p>;
  const cuts = chords.map((chord) => Math.min(chord.at, line.length));
  const head = line.slice(0, cuts[0]);
  return (
    <p>
      {head ? <span className="inline-flex flex-col whitespace-pre"><span style={CHORD_STYLE}>{"\u00a0"}</span>{head}</span> : null}
      {chords.map((chord, index) => (
        // Positional: the same chord twice on a line is two chords.
        <span className="inline-flex flex-col whitespace-pre" key={index}>
          <span data-song-chord="" style={CHORD_STYLE}>
            {chord.name}
            {"\u00a0"}
          </span>
          {line.slice(cuts[index], cuts[index + 1] ?? line.length) || "\u00a0"}
        </span>
      ))}
    </p>
  );
}

/** The footer's own leading. */
const FOOTER_LINE_HEIGHT = 1.25;
/** Between the lyrics and the footer, in `cqw`. */
const FOOTER_GAP_CQW = 1;

/** The height the footer keeps at the bottom of EVERY slide while it is on,
 *  in `cqw` — so the lyrics never move when it appears (owner, 2026-11-04). */
function footerReserveCqw(theme: SongTheme): number {
  if (theme.footer.show === "never") return 0;
  return SONG_FOOTER_LINES * theme.footer.text.sizeCqw * FOOTER_LINE_HEIGHT + FOOTER_GAP_CQW;
}

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
  videoBehind = false,
}: {
  content: SongSlideContent;
  onImageError?: ((url: string) => void) | undefined;
  /** The theme's video plays under this scene: its still is not drawn here. */
  videoBehind?: boolean;
}) {
  const { backgroundUrl, chords, footer, lines, sizeCqw, theme, translation } = content;
  const chorded = chords?.some((line) => line.length > 0) ?? false;
  // A video background paints no colour of its own: the live video is under
  // this scene (`OutputView`'s `SongVideoLayer`), and everywhere else its still
  // is the picture (`backgroundUrl`, `songBackgroundUrl`).
  const background = theme.background.kind === "video" ? null : cssSceneBackground(theme.background);
  const imageBackground =
    theme.background.kind === "image" || (theme.background.kind === "video" && !videoBehind) ? theme.background : null;
  const { bottom, left, right, top } = theme.margins;
  const reserve = footerReserveCqw(theme);
  const { outline } = theme;

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
        style={{ padding: `${top}cqw ${right}cqw ${bottom + reserve}cqw ${left}cqw` }}
      >
        {/* Clipped like the verse: below the theme's floor, what does not fit
            is cut at the margin, and the editor says so. */}
        <div
          className="max-h-full min-h-0 w-full overflow-hidden"
          data-song-block=""
          style={{
            ...sceneTextCss(theme.text),
            fontSize: `${chorded ? sizeCqw * CHORDED_SCALE : sizeCqw}cqw`,
            fontFamily: cssFontFamily(theme.fontFamily),
            lineHeight: theme.lineHeight,
            textAlign: theme.textAlign,
            letterSpacing: `${theme.letterSpacingEm}em`,
            textTransform: theme.uppercase ? "uppercase" : undefined,
            // Drawn under the fill, so it widens each letter outward.
            ...(outline.enabled
              ? { WebkitTextStroke: `${outline.widthCqw * 2}cqw ${outline.color}`, paintOrder: "stroke fill" }
              : {}),
          }}
        >
          {lines.map((line, index) =>
            // Positional on purpose: the same words twice are two lines.
            chorded ? <ChordedLine chords={chords?.[index] ?? []} key={index} line={line} /> : <p key={index}>{line}</p>,
          )}
          {/* Inside the measured block, so the song's one size fits both
              languages; in `em`, so it scales with that size. */}
          {translation && translation.length > 0 ? (
            <div
              data-song-translation=""
              style={{
                color: theme.translation.color,
                fontSize: `${theme.translation.scale}em`,
                fontStyle: theme.translation.italic ? "italic" : undefined,
                marginTop: "0.5em",
              }}
            >
              {translation.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {footer && footer.length > 0 ? (
        <div
          className="absolute flex flex-col justify-end overflow-hidden"
          data-song-footer=""
          style={{
            ...sceneTextCss(theme.footer.text),
            bottom: `${bottom}cqw`,
            fontFamily: cssFontFamily(theme.fontFamily),
            height: `${reserve - FOOTER_GAP_CQW}cqw`,
            left: `${left}cqw`,
            lineHeight: FOOTER_LINE_HEIGHT,
            right: `${right}cqw`,
            textAlign: theme.footer.align,
          }}
        >
          {footer.map((line, index) => (
            <p className="truncate" key={index}>
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}
