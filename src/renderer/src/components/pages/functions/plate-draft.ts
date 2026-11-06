import { isPlateUpsert } from "@shared/overlay-validators";
import {
  DEFAULT_BUG_STYLE,
  DEFAULT_PLATE_STYLE,
  PLATE_KIND_POSITIONS,
  type Plate,
  type PlateKind,
  type PlateUpsert,
} from "@shared/types/overlay";

/** The plate being edited — a plate minus its id, for the reason `SceneDraft`
 *  gives: the modal knows which row it edits. */
export type PlateDraft = Omit<Plate, "id">;

export function emptyPlateDraft(name: string): PlateDraft {
  return {
    name,
    kind: "lower-third",
    position: "bottom-left",
    title: name,
    subtitle: null,
    imageAssetId: null,
    style: DEFAULT_PLATE_STYLE,
  };
}

/** Switching kind keeps the texts but moves what the new kind cannot hold: a
 *  position it does not allow, and a lower third's image. Becoming a bug
 *  drops the band, which is how a bug starts out, and leaving one brings the
 *  default band back; a lower third and a banner hold the same band, so it
 *  stays as the operator set it (QA, 2026-11-06). */
export function withKind(draft: PlateDraft, kind: PlateKind): PlateDraft {
  if (kind === draft.kind) return draft;
  const positions = PLATE_KIND_POSITIONS[kind];
  const band =
    kind === "bug"
      ? DEFAULT_BUG_STYLE.backgroundOpacity
      : draft.kind === "bug"
        ? DEFAULT_PLATE_STYLE.backgroundOpacity
        : draft.style.backgroundOpacity;
  return {
    ...draft,
    kind,
    position: positions.includes(draft.position) ? draft.position : positions[0]!,
    imageAssetId: kind === "bug" ? draft.imageAssetId : null,
    style: { ...draft.style, backgroundOpacity: band },
  };
}

export function toPlateDraft(plate: Plate): PlateDraft {
  const { id: _id, ...draft } = plate;
  return draft;
}

/** The very predicate main runs — see `isDraftSavable` for why. */
export function isPlateDraftSavable(draft: PlateDraft): boolean {
  return isPlateUpsert(draft);
}

export function toPlateUpsert(draft: PlateDraft, id: number | null): PlateUpsert {
  return id === null ? draft : { ...draft, id };
}
