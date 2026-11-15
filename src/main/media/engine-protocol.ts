/**
 * The pure half of talking to the engine process (`media-engine.ts`, `ndi/ndi-output.ts`): nothing here
 * imports `electron`, so it is tested in `tests/main/engine-protocol.test.ts`.
 */

/** 0..1, as `HTMLMediaElement.volume` takes it (linear amplitude) → mpv's `volume`, which it cubes
 *  (`player/audio.c`): sent as it was, the panel's 30% played at 2.7% of full scale. */
export function mpvVolume(volume: number): number {
  return Math.round(Math.cbrt(Math.min(1, Math.max(0, volume))) * 100);
}

/** The engine's stdout, one JSON event per line: a line split across chunks is held until its end
 *  arrives, and one that is not JSON is skipped. */
export function jsonLineReader<T>(onEvent: (event: T) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: T;
      try {
        event = JSON.parse(line) as T;
      } catch {
        continue;
      }
      onEvent(event);
    }
  };
}

/** The first engine protocol with `device`, `devices` and the `level` event (engine-8). An engine that does not
 *  say `hello` first is 7, and answers any command it does not know with `engine-args`, which fails its session. */
export const AUDIO_DEVICE_PROTO = 8;

/** The protocol an engine speaks once `event` is read: its `hello` says; an engine whose first word is anything else
 *  (`ready`, an error) is 7. Once known it stays. */
export function protoAfter(known: number | null, event: { ev: string; proto?: unknown }): number {
  return known ?? (event.ev === "hello" && typeof event.proto === "number" ? event.proto : 7);
}

/** One of mpv's outputs (`audio-device-list`): `name` is what `device` takes, `description` what the OS calls it. */
export type EngineDevice = { name: string; description: string };

/** Each system's own mpv output: the list also carries the same devices through other outputs (macOS's
 *  `avfoundation/`, Linux's `pipewire/` beside `pulse/`), which would make every name ambiguous. Linux takes
 *  `pipewire/` only when mpv has no `pulse/` at all. */
const ENGINE_OUTPUTS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["coreaudio/"],
  win32: ["wasapi/"],
  linux: ["pulse/", "pipewire/"],
};

/**
 * The engine's name for the output Chromium calls `label` (`MediaDeviceInfo` of an `audiooutput`), so a bus plays
 * through ONE device whichever of the two plays it: «auto» for Chromium's `default`; null when no engine device, or
 * more than one, has that name (the caller falls back to the default and says so). By name, the only thing both
 * sides share: Windows' friendly name and Linux's sink description, as they are; macOS's device name, to which
 * Chromium adds its transport: «MacBook Air Speakers (Built-in)», «ZoomAudioDevice (Virtual)», a USB device's
 * «(vid:pid)» (Electron 44, measured 2026-11-15). Chromium's `communications` (Windows) has no engine counterpart.
 */
export function matchEngineDevice(
  output: { deviceId: string; label: string },
  list: readonly EngineDevice[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (output.deviceId === "default") return "auto";
  if (output.deviceId === "communications") return null;
  const prefixes = ENGINE_OUTPUTS[platform] ?? [];
  const prefix = prefixes.find((p) => list.some((d) => d.name.startsWith(p)));
  const named = (label: string) => (prefix ? list.filter((d) => d.name.startsWith(prefix) && d.description.trim() === label) : []);
  let found = named(output.label.trim());
  if (!found.length && platform === "darwin") found = named(output.label.replace(/ \([^()]*\)$/, "").trim());
  return found.length === 1 && output.label.trim() ? found[0]!.name : null;
}
