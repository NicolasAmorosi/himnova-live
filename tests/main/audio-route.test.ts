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
  /** What a real engine is told, line by line; `redraw` is the real one's: a seek where it stands, paused only. */
  class FakeEngine {
    readonly calls: string[] = [];
    load: { device?: string; paused?: boolean } | null = null;
    /** What the session told it to report to: a real engine's stdout events go there. */
    events: { audioOut?: (state: { ok: boolean; device: string }) => void } = {};
    paused = false;
    usable = true;
    position = 0;
    loadFile(opts: { device?: string; paused?: boolean }) {
      this.load = opts;
      this.paused = opts.paused ?? false;
    }
  }
  return {
    FakeEngine,
    engines: [] as InstanceType<typeof FakeEngine>[],
    list: vi.fn<() => Promise<{ name: string; description: string }[] | null>>(),
    proto: vi.fn<() => number | null>(() => 8),
    ndi: vi.fn(),
    broadcast: vi.fn(),
  };
});

vi.mock("../../src/main/media/media-engine", () => ({
  takeEngine: () => {
    const engine = new h.FakeEngine();
    h.engines.push(engine);
    const log = (line: string) => () => engine.calls.push(line);
    return Object.assign(engine, {
      load: (opts: { device?: string; paused?: boolean }, _key: string, events: typeof engine.events) => {
        engine.events = events;
        engine.loadFile(opts);
      },
      setDevice: (device: string) => engine.calls.push(`device ${device}`),
      seek: (at: number) => engine.calls.push(`seek ${at}`),
      setPaused: (paused: boolean) => {
        engine.paused = paused;
        engine.calls.push(`pause ${paused}`);
      },
      setVolume: log("volume"),
      setLoop: log("loop"),
      retarget: (_key: string, events: typeof engine.events) => {
        engine.events = events;
        engine.calls.push("retarget");
      },
      show: () => undefined,
      showOnly: () => undefined,
      redraw: () => {
        if (engine.paused) engine.calls.push(`seek ${engine.position}`);
      },
      quit: log("quit"),
    });
  },
  listAudioDevices: h.list,
  engineAvailable: () => true,
  engineFailsToStart: () => false,
  engineProtocol: h.proto,
}));
vi.mock("../../src/main/ndi/ndi-output", () => ({ setNdiAudioRoute: h.ndi }));
vi.mock("../../src/main/media/engine-assets", () => ({ engineFailedOn: () => false }));
vi.mock("../../src/main/services/repos", () => ({
  getMediaRepo: () => ({ getPathById: (id: number) => `/media/${id}.avi`, survivingId: (id: number) => id }),
}));
vi.mock("../../src/main/services/broadcast", () => ({ broadcast: h.broadcast, controlWindows: () => [] }));

const { matchAudioOutputs, setAudioRoute } = await import("../../src/main/media/audio-route");
const { setPreviewVideo, syncLiveEngine } = await import("../../src/main/media/engine-sessions");
const { projectionState } = await import("../../src/main/services/projection-state");

const ZOOM = "coreaudio/zoom.us.zoomaudiodevice.001";
const SCARLETT = "coreaudio/AppleUSBAudioEngine:Focusrite:Scarlett 2i2";
const projector = { isDestroyed: () => false, once: () => undefined, webContents: { id: 1, send: () => undefined } } as unknown as BrowserWindow;
const control = { id: 2 } as unknown as WebContents;

function liveVideo(assetId: number, epoch: number, paused = false): ProjectionOutput {
  return {
    kind: "video",
    assetId,
    videoUnderlay: { url: engineAssetUrl(assetId), epoch, paused, startAtSeconds: 0, volume: 1, loop: false },
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
  setAudioRoute({ live: ZOOM, preview: null, previewApart: true });
  // One route for both buses: the NDI capture is told LIVE's output and PREVIEW's apart together, never half.
  expect(h.ndi.mock.calls).toEqual([[{ device: ZOOM, previewApart: true }]]);

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

  // LIVE back to the default: what plays moves at once (no seek: it is playing), and so does the NDI capture.
  cold.calls.length = 0;
  setAudioRoute({ live: null, preview: null, previewApart: false });
  expect(cold.calls).toEqual(["device auto"]);
  expect(h.ndi).toHaveBeenLastCalledWith({ device: null, previewApart: false });
  // The same route again (every device change re-sends it) moves no session.
  setAudioRoute({ live: null, preview: null, previewApart: false });
  expect(cold.calls).toEqual(["device auto"]);
});

test("a paused session moved to another output is sought where it stands, so play is not heard late", () => {
  projectionState.setWindow(projector);
  projectionState.send(liveVideo(3, 3, true));
  syncLiveEngine();
  const paused = h.engines.at(-1)!;
  paused.position = 12.5;
  paused.calls.length = 0;
  // mpv reopens a moved output only when sound flows: without the seek, play sounds 244–556 ms late (2026-11-15).
  setAudioRoute({ live: SCARLETT, preview: null, previewApart: true });
  expect(paused.calls).toEqual([`device ${SCARLETT}`, "seek 12.5"]);

  // Playing again, moved back: only the device (a seek would jump it back to its last report).
  projectionState.send(liveVideo(3, 3, false));
  syncLiveEngine();
  paused.calls.length = 0;
  setAudioRoute({ live: null, preview: null, previewApart: false });
  expect(paused.calls).toEqual(["device auto"]);
});

test("an output the engine sessions lose reaches the control window once, and again once it is chosen again", () => {
  setAudioRoute({ live: SCARLETT, preview: null, previewApart: true });
  projectionState.setWindow(projector);
  // Two live sessions on LIVE's output (a video and a deck's WMA) and PREVIEW's on the default.
  projectionState.send(liveVideo(20, 20));
  projectionState.setAudioTracks([{ trackId: "t1", url: engineAssetUrl(21), epoch: 20, paused: false, startAtSeconds: 0, volume: 1, loop: false }]);
  syncLiveEngine();
  const [music, video] = h.engines.slice(-2); // the audio tracks are synced first
  setPreviewVideo({ url: engineAssetUrl(22), paused: true, startAtSeconds: 0, volume: 0, picture: true }, control);
  const previewEngine = h.engines.at(-1)!;
  const said = () => h.broadcast.mock.calls.filter(([channel]) => channel === "audio-out").map(([, payload]) => payload as unknown);
  h.broadcast.mockClear();

  // The engine's own stdout line (`{"ev":"audio-out","ok":false,…}`), through the session's events. Fails if a session
  // never forwards it: the strip stayed green while the room heard nothing (the 2026-11-15 final review).
  video!.events.audioOut?.({ ok: false, device: SCARLETT });
  expect(said()).toEqual([{ device: SCARLETT, ok: false }]);
  // Every other session on that output says the same: once is enough.
  music!.events.audioOut?.({ ok: false, device: SCARLETT });
  expect(said()).toHaveLength(1);
  // PREVIEW's engine speaks too.
  previewEngine.events.audioOut?.({ ok: false, device: "auto" });
  expect(said()).toEqual([{ device: SCARLETT, ok: false }, { device: "auto", ok: false }]);

  // The control window routes LIVE to the default, then the operator chooses that output again and it fails again:
  // said again, or the strip would stay green on a retry.
  setAudioRoute({ live: null, preview: null, previewApart: false });
  setAudioRoute({ live: SCARLETT, preview: null, previewApart: true });
  video!.events.audioOut?.({ ok: false, device: SCARLETT });
  expect(said()).toHaveLength(3);

  // A session that is no longer live (a new file went live) says nothing.
  projectionState.send(liveVideo(23, 23));
  syncLiveEngine();
  setAudioRoute({ live: null, preview: null, previewApart: false });
  video!.events.audioOut?.({ ok: true, device: SCARLETT });
  expect(said()).toHaveLength(3);
  projectionState.setAudioTracks([]);
  syncLiveEngine();
});

test("outputs are matched against the engine's own list; one that cannot choose is told from one that has not answered", async () => {
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

  // An engine-7 said so: only Chromium may move.
  h.list.mockReset();
  h.list.mockResolvedValue(null);
  h.proto.mockReturnValue(7);
  expect(await matchAudioOutputs([zoom])).toBe("none");
  // No answer from an engine that speaks 8, or has not said yet (a spare stopped, slow, or replaced at launch): not
  // «cannot choose». Taking it for an engine-7 put Chromium's files on the chosen output and the engine's on the
  // default (the 2026-11-15 audit).
  for (const proto of [8, null]) {
    h.proto.mockReturnValue(proto);
    expect(await matchAudioOutputs([zoom])).toBe("pending");
  }
});

test("PREVIEW's status comes only from the engine PREVIEW has now, not from one A, B, A left behind", () => {
  const status = { time: 42, duration: 60, paused: false, ended: false };
  const preview = (assetId: number) =>
    setPreviewVideo({ url: engineAssetUrl(assetId), paused: true, startAtSeconds: 0, volume: 0, picture: true }, control);
  preview(7);
  const first = h.engines.at(-1)! as unknown as { events: { status?: (s: typeof status) => void } };
  preview(8);
  preview(7);
  h.broadcast.mockClear();
  // The first engine for 7 was told to quit; a report it had already written lands now. Same url as the current
  // PREVIEW, so the control window would take its time and pause as its own: the bar jumps, or PREVIEW pauses.
  first.events.status?.(status);
  expect(h.broadcast.mock.calls.filter(([channel]) => channel === "preview-video-status")).toEqual([]);
  setPreviewVideo(null, control);
});
