/**
 * LOGO and NEGRO toggle, the buttons like the keys (owner, 2026-11-16). Two cases the toggle must not turn into a
 * picture change (review of the session's commits, 2026-11-16): the projector closed under a cover, opened again by
 * LOGO, uncovered what was live (a video came back with its sound); and with nothing live, LOGO and «uncovered» are
 * the same picture, so a scene between them flashed under «fade through black».
 */
import { beforeEach, expect, test } from "vitest";
import { setOverlayDirect, toggleOverlay } from "@renderer/lib/actions/playback";
import { useDisplayStore } from "@renderer/stores/display.store";
import { useProjectionStore } from "@renderer/stores/projection.store";

const initial = useProjectionStore.getState();
beforeEach(() => {
  useProjectionStore.setState(initial, true);
  useDisplayStore.setState({
    openIfNeeded: () => {
      useProjectionStore.setState({ presentationOpen: true });
      return Promise.resolve();
    },
  });
});

test("LOGO opening a projector closed under LOGO shows the logo, it does not uncover what was live", async () => {
  useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
  useProjectionStore.setState({ overlay: "logo", presentationOpen: false });
  await toggleOverlay("logo");
  expect(useProjectionStore.getState().overlay).toBe("logo");
  // Open now: the second press toggles, as always.
  await toggleOverlay("logo");
  expect(useProjectionStore.getState().overlay).toBe("none");
});

test("with nothing live, LOGO pressed twice changes no picture and opens no scene", async () => {
  useProjectionStore.setState({ presentationOpen: true });
  const epoch = useProjectionStore.getState().sceneEpoch;
  await toggleOverlay("logo");
  await toggleOverlay("logo");
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
  // NEGRO is another picture: its scene stays.
  await toggleOverlay("black");
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch + 1);
});

test("LOGO pressed with the projector closed under LOGO opens it on the logo without a fade from the logo to itself", async () => {
  useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
  useProjectionStore.setState({ overlay: "logo", presentationOpen: false });
  const epoch = useProjectionStore.getState().sceneEpoch;
  await toggleOverlay("logo");
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch);
});

test("VIVO lifts NEGRO with a fade, and pressed again changes nothing", async () => {
  useProjectionStore.getState().setBase({ kind: "image", assetId: 3 });
  useProjectionStore.setState({ overlay: "black", presentationOpen: true });
  const epoch = useProjectionStore.getState().sceneEpoch;
  await setOverlayDirect("none");
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch + 1);
  await setOverlayDirect("none");
  expect(useProjectionStore.getState().sceneEpoch).toBe(epoch + 1);
});
