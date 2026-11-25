import { execFile } from "node:child_process";

/** The sound server answers in a few ms; one that hangs must not hold the route back. */
const TIMEOUT_MS = 1500;

/** `pactl` with its answers in English (a Spanish desktop says «Descripción:»), never through a shell. */
function pactl(...args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("pactl", args, { timeout: TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

/** The description of the sink named `name` in `pactl --format=json list sinks` (pactl 16 and later). */
export function sinkDescriptionFromJson(json: string, name: string): string | null {
  try {
    const sinks: unknown = JSON.parse(json);
    if (!Array.isArray(sinks)) return null;
    const sink = (sinks as { name?: unknown; description?: unknown }[]).find((candidate) => candidate?.name === name);
    return typeof sink?.description === "string" && sink.description !== "" ? sink.description : null;
  } catch {
    return null;
  }
}

/** The same from the plain `pactl list sinks` (older pactl), read in the C locale. */
export function sinkDescriptionFromText(text: string, name: string): string | null {
  for (const block of text.split(/^Sink #/m)) {
    if (block.match(/^\s*Name: (.*)$/m)?.[1]?.trim() !== name) continue;
    return block.match(/^\s*Description: (.*)$/m)?.[1]?.trim() || null;
  }
  return null;
}

/**
 * The name of the device the system's default output is, as the sound server describes it, on Linux: Chromium's
 * «default» entry there is just «Default», so the control window cannot tell which listed output it is
 * (`audioOutputsOf`), and Chromium labels each output with that same description (measured on CachyOS with PipeWire,
 * 2026-11-25). Null anywhere else, and whenever `pactl` is missing, slow or says something unexpected: the default
 * stays unknown, the safe side.
 */
export async function systemDefaultOutputLabel(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const name = (await pactl("get-default-sink"))?.trim();
  if (!name) return null;
  const json = await pactl("--format=json", "list", "sinks");
  const described = json === null ? null : sinkDescriptionFromJson(json, name);
  if (described !== null) return described;
  const text = await pactl("list", "sinks");
  return text === null ? null : sinkDescriptionFromText(text, name);
}
