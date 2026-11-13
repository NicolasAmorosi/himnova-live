// The NDI® test receiver (`native/ndi-probe`) and the app's output turned on for it — shared by the specs that
// measure what a receiver gets (`ndi-receiver.spec.ts`, `ndi-start.spec.ts`).
//
// Needs the NDI runtime (skipped without one, like the output itself) and the probe built for this computer:
// `native/build.sh ndi-probe <darwin-arm64|win32-x64|linux-x64>` — a missing probe FAILS, never skips.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type WorshipApp } from "./app";

export const PROBE = path.join(
  process.cwd(),
  "native",
  ".build",
  `ndi-probe-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}${process.platform === "win32" ? ".exe" : ""}`,
);
// Its own name each run: an NDI finder still lists a source whose sender was killed — another computer's test run of
// the same name, hours later, was found first and gave 0 frames.
const NAME = `Himnova E2E ${process.pid}`;

export type NdiSource = { name: string; url: string };

/** One run of the probe; its last line, parsed. */
export function probe<T>(...args: string[]): Promise<T> {
  return new Promise((resolve, reject) =>
    execFile(PROBE, args, { timeout: 60_000 }, (_error, out) => {
      const line = String(out).trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(line) as T);
      } catch {
        reject(new Error(`ndi-probe ${args[0]}: ${String(out)}`));
      }
    }),
  );
}

/** A received frame (`ndi-probe frames`): wall-clock ms, its barcode (-1 without one), its mean luma (~16 black). */
export type ReceivedFrame = { t: number; n: number; luma: number };

/** Starts receiving now, every frame for `seconds`; resolves with all of them once the probe ends. */
export function receiveFrames(ndi: NdiSource, seconds: number): Promise<ReceivedFrame[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(PROBE, ["frames", ndi.name, ndi.url, String(seconds)]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
    child.once("error", reject);
    child.once("exit", () =>
      resolve(
        out
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as ReceivedFrame),
      ),
    );
  });
}

/** The output on, with its sound; `null` when this computer has no NDI runtime. */
export async function source(app: WorshipApp): Promise<NdiSource | null> {
  await app.invoke("settings:set", { "ndi.output.name": NAME, "ndi.output.audio": true, "ndi.output.audioDelayMs": 0 });
  await app.invoke("settings:set", { "ndi.output.enabled": true });
  const state = async () => (await app.invoke<{ state: string }>("ndi:getStatus")).state;
  await expect.poll(state, { timeout: 30_000 }).toMatch(/sending|runtime-missing/);
  if ((await state()) === "runtime-missing") return null;
  expect(fs.existsSync(PROBE), `the NDI test receiver is not built: native/build.sh ndi-probe (${PROBE})`).toBe(true);
  const found = await probe<{ name: string | null; url: string }>("find", `(${NAME})`, "10");
  expect(found.name, `«${NAME}» is not listed by an NDI finder`).not.toBeNull();
  return { name: found.name!, url: found.url };
}
