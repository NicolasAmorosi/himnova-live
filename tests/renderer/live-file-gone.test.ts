/**
 * What is on air is never cut to black by a file that went away (2026-11-22 audit, RV-2 and RV-3). The sweep marks a
 * missing file on focus and every 5 minutes, so GO LIVE looks at the file itself before it cuts: a file gone since
 * is refused the way one already marked is, and what the congregation sees stays.
 */
import { beforeEach, expect, test, vi } from "vitest";
import { goLive } from "@renderer/lib/actions/playback";
import { previewScheduleItem } from "@renderer/lib/actions/preview";
import { useAudioStore } from "@renderer/stores/audio.store";
import { useDisplayStore } from "@renderer/stores/display.store";
import { usePreviewStore } from "@renderer/stores/preview.store";
import { useProgramStore } from "@renderer/stores/program.store";
import { useProjectionStore } from "@renderer/stores/projection.store";
import { useToastStore } from "@renderer/stores/toast.store";
import type { MediaAsset } from "@shared/types/media";
import type { ProgramItemDTO } from "@shared/types/program";

const asset = (id: number, kind: MediaAsset["kind"]): MediaAsset => ({
  id,
  kind,
  name: `asset ${id}`,
  ext: kind === "video" ? "mp4" : kind === "ppt" ? "pptx" : "png",
  path: `/media/${id}`,
  sizeBytes: 1,
  mtimeMs: 1,
  durationMs: null,
  linkedAudioPath: null,
  inLibrary: true,
  missingSince: null,
  createdAt: 0,
  updatedAt: 0,
});

/** The rows as the last sweep left them, and the files as they are on disk now (what a `check` answers). */
let swept: MediaAsset[] = [];
let onDisk: MediaAsset[] = [];

const media = (id: number, mediaAssetId: number): ProgramItemDTO => ({ id, position: id, kind: "media", mediaAssetId, title: null });

const initialProjection = useProjectionStore.getState();
const initialProgram = useProgramStore.getState();
const initialAudio = useAudioStore.getState();

beforeEach(() => {
  (window as unknown as { worship: unknown }).worship = {
    invoke: vi.fn((channel: string, req: { id?: number; check?: boolean }) => {
      const rows = req.check ? onDisk : swept;
      const data = channel === "library:get" ? (rows.find((a) => a.id === req.id) ?? null) : null;
      return Promise.resolve({ ok: true, data });
    }),
    on: () => () => {},
  };
  useProjectionStore.setState(initialProjection, true);
  useProgramStore.setState(initialProgram, true);
  useAudioStore.setState(initialAudio, true);
  useToastStore.setState({ toasts: [] });
  usePreviewStore.getState().clear();
  useDisplayStore.setState({ openIfNeeded: async () => {} });
});

const verseOnAir = () =>
  useProjectionStore.getState().setBase({ kind: "bible", text: "Juan 3:16", reference: "Juan 3:16", versionLabel: null, parallel: null });

test.each([
  ["a video", "video"],
  ["an image", "image"],
] as const)("%s gone since the last sweep never takes the verse off the projector", async (_, kind) => {
  swept = [asset(5, kind)];
  onDisk = [{ ...asset(5, kind), missingSince: 123 }]; // the pendrive pulled two minutes ago
  verseOnAir();
  useProgramStore.setState({ items: [media(10, 5)] });
  previewScheduleItem(0);
  await goLive();

  expect(useProjectionStore.getState().base).toMatchObject({ kind: "bible", reference: "Juan 3:16" });
  expect(useProgramStore.getState().activeIndex).toBeNull();
  expect(useToastStore.getState().toasts.map((t) => t.tone)).toEqual(["warning"]);
});
