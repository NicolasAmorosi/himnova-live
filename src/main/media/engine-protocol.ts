/**
 * The pure half of talking to the engine process (`media-engine.ts`, `ndi/ndi-output.ts`): nothing here
 * imports `electron`, so it is tested in `tests/main/engine-protocol.test.ts`.
 */

/** How much of a file main reads before the engine may open it (`textInsteadOfMedia`). */
export const SNIFF_BYTES = 4096;

/** A byte no text file carries: below a space, but for tab, line feed, form feed and carriage return. UTF-8 or not:
 *  a Latin-1 list is a list all the same. */
const controlByte = (b: number): boolean => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d;

/** A first line that makes mpv (or FFmpeg under it) read the file as a list of other things to play. */
const REFERENCE_LINE =
  /^(#EXTM3U|# mpv EDL|\[playlist\]|\[Reference\]|edl:\/\/|ffconcat |v=0|[a-z][a-z0-9+.-]*:\/\/|\/|[a-z]:[\\/]|\\\\)/i;

/**
 * Whether the first bytes of a file the engine is about to open (`SNIFF_BYTES` of them) are text, not audio or video:
 * a playlist (M3U, HLS, PLS), an mpv EDL or a reference dressed up with a video's extension. ffprobe cannot read one,
 * so it goes to the engine by its extension, and mpv recognises the list by its content: it projected ANOTHER local
 * file and fetched a URL from someone else's server (2026-11-15 audit, S1). No audio or video container is plain text,
 * so a head with no control byte is refused whole; a text first line that names a list, a URL or an absolute path is
 * refused even with binary after it. A UTF-16 list with its BOM also played (measured): only its first line is read,
 * as an MPEG audio frame may start with the same two bytes. The native half (`access-references=no`) is engine-9's.
 */
export function textInsteadOfMedia(head: Uint8Array): boolean {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return listLine(bytes.toString("utf16le", 2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return listLine(Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1))).swap16().toString("utf16le"));
  if (!bytes.some(controlByte)) return true;
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return listLine(bytes.toString("latin1", bom));
}

/** Whether `text` starts with a whole line of text that names a list, a URL or an absolute path: only a whole line,
 *  as a binary stream may well start with the byte of a `/`. */
function listLine(text: string): boolean {
  const line = text.slice(0, Math.max(0, text.indexOf("\n")));
  for (let i = 0; i < line.length; i++) if (controlByte(line.charCodeAt(i))) return false;
  return REFERENCE_LINE.test(line.trim());
}

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

/**
 * What main writes to one engine, in the order it wrote it, held until the engine has said which protocol it speaks
 * (`protoAfter`): a `pause`, `seek` or `loop` written before then went out ahead of a `load` that was waiting for
 * `hello`, and the `load` then set the old value again. A line for a newer protocol than the engine's is dropped.
 */
export class EngineGate {
  private known: number | null = null;
  private readonly waiting: ((proto: number) => void)[] = [];

  constructor(private readonly write: (line: string) => void) {}

  /** null until the engine's first event. */
  get proto(): number | null {
    return this.known;
  }

  /** Every event the engine prints: the first says its protocol, and what waited for it goes out, in order. */
  heard(event: { ev: string; proto?: unknown }): number {
    if (this.known === null) {
      const proto = protoAfter(null, event);
      this.known = proto;
      for (const then of this.waiting.splice(0)) then(proto);
    }
    return this.known;
  }

  /** `then` once the protocol is known (at once when it is), in order with every `send`. */
  after(then: (proto: number) => void): void {
    if (this.known === null) this.waiting.push(then);
    else then(this.known);
  }

  /** `line` to the engine, in order; dropped by an engine older than `since`. */
  send(line: string, since = 0): void {
    this.after((proto) => {
      if (proto >= since) this.write(line);
    });
  }
}

/** The first protocol whose NDI sender takes «audio-delay <ms>» on stdin (engine-10). */
export const NDI_DELAY_PROTO = 9;

/** The line that moves a running NDI sender's sound delay, or none to one too old to take it (it is restarted). */
export function ndiDelayLine(proto: number, ms: number): string {
  return proto >= NDI_DELAY_PROTO ? `audio-delay ${Math.round(ms)}\n` : "";
}

/** The NDI sender's lines that move its capture (`native/engine/ndi.cpp`), the device last: it is the one the sender
 *  acts on. Sent whole every time, unchanged too: the same route starts a capture that stopped (its device was gone and
 *  is back). None to a sender older than `AUDIO_DEVICE_PROTO`, which on Windows answers an unknown line with `done`
 *  and main would release the texture it is still reading. */
export function ndiRouteLines(proto: number, route: { device: string | null; previewApart: boolean }): string {
  if (proto < AUDIO_DEVICE_PROTO) return "";
  return `preview-apart ${route.previewApart ? 1 : 0}\naudio-device ${route.device ?? "auto"}\n`;
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
