/**
 * Unplugging an output mid-service (`effects/audio-route.ts`), which a Mac cannot simulate in the E2E suite: the bus
 * goes to the system's default whole (the projector's elements AND main's engine), the operator is told once, and the
 * device plugged back in is used again by itself. Chromium's device list is a stand-in that fires `devicechange`;
 * main's answer is the engine's name for each device.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import type { AudioRoute, EngineOutputNames } from "@shared/types/audio";

const h = vi.hoisted(() => ({
  match: vi.fn<(outputs: { deviceId: string; label: string }[]) => Promise<EngineOutputNames>>(),
  set: vi.fn<(route: AudioRoute) => Promise<void>>(() => Promise.resolve()),
  listeners: new Map<string, ((payload: never) => void)[]>(),
}));
vi.mock("@renderer/lib/api", () => ({ api: { audioRoute: { matchOutputs: h.match, set: h.set } } }));
vi.mock("@renderer/lib/ipc", () => ({
  onIpc: (event: string, listener: (payload: never) => void) => {
    const list = h.listeners.get(event) ?? [];
    h.listeners.set(event, [...list, listener]);
    return () => h.listeners.set(event, (h.listeners.get(event) ?? []).filter((l) => l !== listener));
  },
}));
/** What main sends the control window: an engine session's `audio-out`, a window's failed `setSinkId`. */
function emit(event: "audio-out", payload: { device: string; ok: boolean }): void;
function emit(event: "audio-sink-failed", payload: { sinkId: string }): void;
function emit(event: string, payload: unknown): void {
  for (const listener of h.listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload);
}

const { startAudioRouteEffects } = await import("@renderer/effects/audio-route");
const { useAudioRouteStore } = await import("@renderer/stores/audio-route.store");
const { useProjectionStore } = await import("@renderer/stores/projection.store");
const { useSettingsStore } = await import("@renderer/stores/settings.store");
const { useToastStore } = await import("@renderer/stores/toast.store");

const SCARLETT = "pulse/alsa_output.usb-Focusrite_Scarlett_2i2";
const device = (deviceId: string, label: string, groupId: string) =>
  ({ deviceId, label, groupId, kind: "audiooutput", toJSON: () => ({}) }) as MediaDeviceInfo;
const speakers = [device("default", "Predeterminado - Altavoces", "g-speakers"), device("a1", "Altavoces", "g-speakers")];
const scarlett = device("b2", "Scarlett 2i2", "g-scarlett");

let plugged: MediaDeviceInfo[] = [];
const devices = new EventTarget() as EventTarget & { enumerateDevices: () => Promise<MediaDeviceInfo[]> };
devices.enumerateDevices = () => Promise.resolve(plugged);
Object.defineProperty(navigator, "mediaDevices", { value: devices, configurable: true });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}: ${toast.message}`);
let stop: () => void = () => undefined;

beforeEach(() => {
  h.set.mockImplementation(() => Promise.resolve());
  h.match.mockImplementation((outputs) => Promise.resolve(outputs.map((o) => (o.label === "Scarlett 2i2" ? SCARLETT : null))));
  useSettingsStore.setState({
    loaded: true,
    settings: { ...DEFAULT_SETTINGS, "ui.locale": "es", "audio.output.live": { label: "Scarlett 2i2", deviceId: "b2" } },
  });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => stop());

test("an output unplugged mid-service sends LIVE to the default, says so once, and comes back by itself", async () => {
  plugged = [...speakers, scarlett];
  stop = startAudioRouteEffects();
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b2", engineDevice: SCARLETT });
  expect(h.set).toHaveBeenLastCalledWith({ live: SCARLETT, preview: null, previewApart: true });
  expect(toasts()).toEqual([]);

  // Unplugged: the whole bus to the default (Chromium "" and the engine's default), never half of it.
  plugged = [...speakers];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "", engineDevice: null });
  expect(useAudioRouteStore.getState().live.state).toBe("missing");
  // PREVIEW and LIVE now share the default: the NDI sound may carry PREVIEW (D6), and the strip says so.
  expect(useAudioRouteStore.getState().shared).toBe(true);
  expect(h.set).toHaveBeenLastCalledWith({ live: null, preview: null, previewApart: false });
  expect(toasts()).toEqual(["warning: Salida de EN VIVO: Scarlett 2i2 no está conectada. Suena por la predeterminada del sistema."]);

  // Another device coming or going while it is still out: no second toast.
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  expect(toasts()).toHaveLength(1);

  // Plugged back in (another port, another id): used again by itself, by its name.
  plugged = [...speakers, device("b9", "Scarlett 2i2", "g-scarlett")];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b9", engineDevice: SCARLETT });
  expect(useAudioRouteStore.getState().live.state).toBe("ok");
  expect(toasts()[1]).toBe("info: Salida de EN VIVO: Scarlett 2i2 está conectada de nuevo.");
});

test("a device the engine cannot open is not used by Chromium either, and choosing it says why", async () => {
  plugged = [...speakers, scarlett, device("t1", "Microsoft Teams Audio", "g-teams")];
  stop = startAudioRouteEffects();
  await settle();
  void useSettingsStore.setState((state) => ({
    settings: { ...state.settings, "audio.output.live": { label: "Microsoft Teams Audio", deviceId: "t1" } },
  }));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "", engineDevice: null });
  expect(useAudioRouteStore.getState().live.state).toBe("unusable");
  expect(toasts()).toEqual(["warning: Salida de EN VIVO: Microsoft Teams Audio no se puede usar. Suena por la predeterminada del sistema."]);
  // Chosen again to something that works: no «back» toast, the operator is looking at his own choice.
  void useSettingsStore.setState((state) => ({ settings: { ...state.settings, "audio.output.live": { label: "Scarlett 2i2", deviceId: "b2" } } }));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b2", engineDevice: SCARLETT });
  expect(toasts()).toHaveLength(1);
});

test("with an engine that cannot choose (engine-7), only Chromium moves", async () => {
  h.match.mockResolvedValue("none");
  plugged = [...speakers, scarlett];
  stop = startAudioRouteEffects();
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b2", engineDevice: null });
  expect(useAudioRouteStore.getState().live.state).toBe("ok");
});

test("an output the engine says it cannot open sends the bus to the default, until it is unplugged and back", async () => {
  // Matched by name, but mpv fails to open it (a virtual device; `audio-out` from the session that tried).
  plugged = [...speakers, scarlett];
  stop = startAudioRouteEffects();
  await settle();
  expect(useProjectionStore.getState().liveAudioOut.engineDevice).toBe(SCARLETT);
  emit("audio-out", { device: SCARLETT, ok: false });
  await settle();
  // Fails if Chromium stays on it while the engine plays its files into nothing: one bus, one device.
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "", engineDevice: null });
  expect(useAudioRouteStore.getState().live.state).toBe("unusable");
  // Another device plugged in: still refused (no flapping onto a device that cannot open).
  plugged = [...speakers, scarlett, device("c3", "Auriculares", "g-phones")];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut.sinkId).toBe("");
  // Unplugged and plugged back in: tried again.
  plugged = [...speakers];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  plugged = [...speakers, scarlett];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b2", engineDevice: SCARLETT });
});

test("main hears both buses in one route, before the projector's output carries LIVE's", async () => {
  // Fails if PREVIEW's half reaches main alone: main applied «LIVE old, PREVIEW apart» and moved the NDI capture twice.
  const seen: string[] = [];
  h.set.mockImplementation((route) => {
    seen.push(`main: LIVE ${route.live ?? "default"}${route.previewApart ? " (apart)" : ""}`);
    return Promise.resolve();
  });
  plugged = [...speakers, scarlett];
  useProjectionStore.getState().setLiveAudioOut({ sinkId: "", engineDevice: null });
  const unsubscribe = useProjectionStore.subscribe((state, previous) => {
    if (state.liveAudioOut !== previous.liveAudioOut) seen.push(`output: LIVE ${state.liveAudioOut.engineDevice ?? "default"}`);
  });
  stop = startAudioRouteEffects();
  await settle();
  unsubscribe();
  expect(seen).toEqual([`main: LIVE ${SCARLETT} (apart)`, `output: LIVE ${SCARLETT}`]);
});

test("an engine that has not answered keeps the bus whole on the default, and is asked again until it does", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  try {
    h.match.mockResolvedValue("pending");
    plugged = [...speakers, scarlett];
    stop = startAudioRouteEffects();
    await tick();
    // Not Chromium on the Scarlett with the engine's files on the default (the 2026-11-15 audit's split).
    expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "", engineDevice: null });
    expect(h.set).toHaveBeenLastCalledWith({ live: null, preview: null, previewApart: false });
    expect(useAudioRouteStore.getState().live.state).toBe("pending");
    // Waiting is said on the strip, not in a toast.
    expect(toasts()).toEqual([]);

    const asked = h.match.mock.calls.length;
    await tick(2000);
    expect(h.match.mock.calls.length).toBe(asked + 1);
    // It answers: the chosen output for both sides at once, and no «connected again» for a device that never left.
    h.match.mockImplementation((outputs) => Promise.resolve(outputs.map((o) => (o.label === "Scarlett 2i2" ? SCARLETT : null))));
    await tick(2000);
    expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b2", engineDevice: SCARLETT });
    expect(useAudioRouteStore.getState().live.state).toBe("ok");
    expect(toasts()).toEqual([]);
    // Settled: nobody asks again.
    const settled = h.match.mock.calls.length;
    await tick(10_000);
    expect(h.match.mock.calls.length).toBe(settled);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

test("a window that could not move its elements to the output sends the bus to the default whole", async () => {
  plugged = [...speakers, scarlett];
  stop = startAudioRouteEffects();
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "b2", engineDevice: SCARLETT });
  // The projector's `setSinkId("b2")` failed: its elements stay where they were while the engine moved.
  emit("audio-sink-failed", { sinkId: "b2" });
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "", engineDevice: null });
  expect(h.set).toHaveBeenLastCalledWith({ live: null, preview: null, previewApart: false });
  expect(useAudioRouteStore.getState().live.state).toBe("unusable");
  expect(toasts()).toEqual(["warning: Salida de EN VIVO: Scarlett 2i2 no se puede usar. Suena por la predeterminada del sistema."]);
  // A failure of an output nobody uses any more changes nothing.
  emit("audio-sink-failed", { sinkId: "zz" });
  await settle();
  expect(toasts()).toHaveLength(1);
});
