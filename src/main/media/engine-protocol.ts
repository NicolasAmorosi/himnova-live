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
