/**
 * Unplugging an output mid-service (`effects/audio-route.ts`), which a Mac cannot simulate in the E2E suite: the bus
 * goes to the system's default whole (the projector's elements AND main's engine), the operator is told once, and the
 * device plugged back in is used again by itself. Chromium's device list is a stand-in that fires `devicechange`;
 * main's answer is the engine's name for each device.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/types/settings";
import type { AudioRoute } from "@shared/types/audio";

const h = vi.hoisted(() => ({
  match: vi.fn<(outputs: { deviceId: string; label: string }[]) => Promise<(string | null)[] | null>>(),
  set: vi.fn<(route: AudioRoute) => Promise<void>>(() => Promise.resolve()),
  audioOut: [] as ((payload: { device: string; ok: boolean }) => void)[],
}));
vi.mock("@renderer/lib/api", () => ({ api: { audioRoute: { matchOutputs: h.match, set: h.set } } }));
vi.mock("@renderer/lib/ipc", () => ({
  onIpc: (event: string, listener: (payload: { device: string; ok: boolean }) => void) => {
    if (event === "audio-out") h.audioOut.push(listener);
    return () => h.audioOut.splice(h.audioOut.indexOf(listener), 1);
  },
}));

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
  expect(h.set).toHaveBeenLastCalledWith({ preview: null, previewApart: true });
  expect(toasts()).toEqual([]);

  // Unplugged: the whole bus to the default (Chromium "" and the engine's default), never half of it.
  plugged = [...speakers];
  devices.dispatchEvent(new Event("devicechange"));
  await settle();
  expect(useProjectionStore.getState().liveAudioOut).toEqual({ sinkId: "", engineDevice: null });
  expect(useAudioRouteStore.getState().live.state).toBe("missing");
  // PREVIEW and LIVE now share the default: the NDI sound may carry PREVIEW (D6), and the strip says so.
  expect(useAudioRouteStore.getState().shared).toBe(true);
  expect(h.set).toHaveBeenLastCalledWith({ preview: null, previewApart: false });
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
  h.match.mockResolvedValue(null);
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
  for (const listener of h.audioOut) listener({ device: SCARLETT, ok: false });
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
