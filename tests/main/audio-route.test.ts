/**
 * Where the engine's sound goes (`media/audio-route.ts` over `media/engine-sessions.ts`): the control window resolves,
 * main applies. The engine process itself is the boundary this suite never crosses, so `media-engine` (and the NDI
 * sender, which imports `electron`) are replaced by recorders of what they are told: each line here is a command a
 * real engine would get, and the routing proof that it SOUNDS there is the Linux null-sink run (plan F3a).
 */
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type { ProjectionOutput } from "@shared/types/projection";
import { INSTANT_TRANSITION } from "@shared/types/projection";
import { engineAssetUrl } from "@shared/urls";

const h = vi.hoisted(() => {
  class FakeEngine {
    readonly calls: string[] = [];
    load: { device?: string } | null = null;
    usable = true;
    position = 0;
    loadFile(opts: { device?: string }) {
      this.load = opts;
    }
  }
  return {
    FakeEngine,
    engines: [] as InstanceType<typeof FakeEngine>[],
    list: vi.fn<() => Promise<{ name: string; description: string }[] | null>>(),
    proto: vi.fn<() => number | null>(() => 8),
    ndi: vi.fn(),
  };
});

vi.mock("../../src/main/media/media-engine", () => ({
  takeEngine: () => {
    const engine = new h.FakeEngine();
    h.engines.push(engine);
    const log = (line: string) => () => engine.calls.push(line);
    return Object.assign(engine, {
      load: (opts: { device?: string }) => engine.loadFile(opts),
      setDevice: (device: string) => engine.calls.push(`device ${device}`),
      seek: (at: number) => engine.calls.push(`seek ${at}`),
      setPaused: (paused: boolean) => engine.calls.push(`pause ${paused}`),
      setVolume: log("volume"),
      setLoop: log("loop"),
      retarget: log("retarget"),
      show: () => undefined,
      showOnly: () => undefined,
      redraw: () => undefined,
      quit: log("quit"),
    });
  },
  listAudioDevices: h.list,
  engineAvailable: () => true,
  engineProtocol: h.proto,
}));
vi.mock("../../src/main/ndi/ndi-output", () => ({ setNdiAudioRoute: h.ndi }));
vi.mock("../../src/main/services/repos", () => ({ getMediaRepo: () => ({ getPathById: (id: number) => `/media/${id}.avi` }) }));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: () => undefined, controlWindows: () => [] }));

const { applyLiveAudioOut, matchAudioOutputs, setAudioRoute } = await import("../../src/main/media/audio-route");
const { setPreviewVideo, syncLiveEngine } = await import("../../src/main/media/engine-sessions");
const { projectionState } = await import("../../src/main/services/projection-state");

const ZOOM = "coreaudio/zoom.us.zoomaudiodevice.001";
const projector = { isDestroyed: () => false, once: () => undefined, webContents: { id: 1, send: () => undefined } } as unknown as BrowserWindow;
const control = { id: 2 } as unknown as WebContents;

function liveVideo(assetId: number, epoch: number): ProjectionOutput {
  return {
    kind: "video",
    assetId,
    videoUnderlay: { url: engineAssetUrl(assetId), epoch, paused: false, startAtSeconds: 0, volume: 1, loop: false },
    slideVideo: null,
    plates: [],
    transition: INSTANT_TRANSITION,
  } as unknown as ProjectionOutput;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
  projectionState.setWindow(null);
});

test("LIVE's output moves its sessions, GO LIVE moves PREVIEW's engine to it, and the NDI sound follows LIVE", () => {
  setAudioRoute({ preview: null, previewApart: true });
  applyLiveAudioOut({ sinkId: "z1", engineDevice: ZOOM });
  expect(h.ndi).toHaveBeenLastCalledWith({ device: ZOOM, previewApart: true });

  // PREVIEW opens the file on its own output (the default here).
  setPreviewVideo({ url: engineAssetUrl(1), paused: true, startAtSeconds: 0, volume: 0, picture: true }, control);
  const previewEngine = h.engines[0]!;
  expect(previewEngine.load?.device).toBeUndefined();

  // GO LIVE takes that engine: it moves to LIVE's output while held, and the seek where it stands reopens the output
  // before play (`.claude/knowledge/an-audio-output-is-named-differently-…`). Fails if the room's video stays on
  // PREVIEW's headphones.
  projectionState.setWindow(projector);
  projectionState.send(liveVideo(1, 1));
  syncLiveEngine();
  expect(previewEngine.calls).toEqual(expect.arrayContaining([`device ${ZOOM}`, "seek 0"]));
  expect(previewEngine.calls.indexOf(`device ${ZOOM}`)).toBeLessThan(previewEngine.calls.indexOf("seek 0"));
  // PREVIEW gets an engine of its own again, on PREVIEW's output.
  expect(h.engines[1]?.load?.device).toBeUndefined();

  // A live video opened cold starts on LIVE's output.
  projectionState.send(liveVideo(2, 2));
  syncLiveEngine();
  const cold = h.engines.at(-1)!;
  expect(cold.load?.device).toBe(ZOOM);

  // LIVE back to the default: what plays moves at once, and so does the NDI capture.
  const ndiCalls = h.ndi.mock.calls.length;
  applyLiveAudioOut(undefined);
  expect(cold.calls).toContain("device auto");
  expect(h.ndi).toHaveBeenLastCalledWith({ device: null, previewApart: true });
  // The same output again (every push carries it) moves nothing more.
  applyLiveAudioOut(undefined);
  expect(h.ndi.mock.calls.length).toBe(ndiCalls + 1);
  // A route told again (a device came or went) reaches the NDI sender even unchanged: that re-arms its capture.
  setAudioRoute({ preview: null, previewApart: true });
  expect(h.ndi.mock.calls.length).toBe(ndiCalls + 2);
});

test("outputs are matched against the engine's own list; an engine that cannot choose answers null", async () => {
  h.list.mockResolvedValueOnce([
    { name: "auto", description: "Autoselect device" },
    { name: "coreaudio/BuiltInSpeakerDevice", description: "MacBook Air Speakers" },
    { name: ZOOM, description: "ZoomAudioDevice" },
    { name: "avfoundation/zoom.us.zoomaudiodevice.001", description: "ZoomAudioDevice" },
  ]);
  const zoom = { deviceId: "z1", label: "ZoomAudioDevice (Virtual)" };
  const teams = { deviceId: "t1", label: "Microsoft Teams Audio (Virtual)" };
  // macOS only: other systems' labels are the device's name as it is.
  if (process.platform === "darwin") expect(await matchAudioOutputs([zoom, teams])).toEqual([ZOOM, null]);

  // An engine-7 says so once: no second question, and the control window leaves the engine on the default.
  h.list.mockReset();
  h.list.mockResolvedValue(null);
  h.proto.mockReturnValue(7);
  expect(await matchAudioOutputs([zoom])).toBeNull();
  expect(h.list).toHaveBeenCalledTimes(1);
  // No answer yet from an engine that may speak 8 (its spare replaced at launch): asked once more.
  h.proto.mockReturnValue(null);
  h.list.mockClear();
  expect(await matchAudioOutputs([zoom])).toBeNull();
  expect(h.list).toHaveBeenCalledTimes(2);
});
