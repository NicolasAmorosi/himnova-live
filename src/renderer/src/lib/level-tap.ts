/**
 * What this window's media elements sound at, for the audio strips' meters: the projector's live `<video>`/`<audio>`
 * (`ProjectionApp`, sent to main) and PREVIEW's `<video>` (`effects/audio-levels.ts`).
 *
 * Each element that sounds is measured off a COPY of its sound (`captureStream()`) in an `AudioContext` that outputs
 * nothing; never `createMediaElementSource`, which reroutes the element's sound through Web Audio: its output device
 * (`setSinkId`) would stop applying, and a Web Audio failure would silence the room. The copy needs CORS, hence
 * `crossOrigin="anonymous"` on every media element and `serve-file.ts`'s header. One analyser pair per sounding
 * element, gone when it stops; nothing runs while nothing plays.
 */

/** Left and right in dBFS (sample peak); `-Infinity` is silence. */
export type TapLevel = [number, number];

const TICK_MS = 40;
/** 43 ms at 48 kHz: read every 40 ms, every sample is seen. */
const WINDOW_SAMPLES = 2048;

type Tap = { stream: MediaStream; nodes: AudioNode[]; analysers: AnalyserNode[] };
type Capturable = HTMLMediaElement & { captureStream(): MediaStream };

const audible = (element: HTMLMediaElement): boolean =>
  element.isConnected && !element.paused && !element.ended && !element.muted && element.volume > 0;

/**
 * Starts measuring `elements()` (asked again every tick, so elements that come and go need no wiring) and calls
 * `send` every 40 ms while one of them sounds, then once silent. Each level is the loudest element's, through its
 * own volume: what the room hears from it. Returns the stop.
 */
export function startLevelTap(elements: () => Iterable<HTMLMediaElement>, send: (level: TapLevel) => void): () => void {
  let context: AudioContext | null = null;
  const taps = new Map<HTMLMediaElement, Tap>();
  /** An element whose source could not be measured (no sound in it, or refused), with that source: not asked again. */
  const unmeasurable = new WeakMap<HTMLMediaElement, string>();
  const samples = new Float32Array(WINDOW_SAMPLES);
  let timer: ReturnType<typeof setInterval> | null = null;
  let sounded = false;

  const open = (element: HTMLMediaElement): Tap | null => {
    let captured: MediaStream;
    try {
      captured = (element as Capturable).captureStream();
    } catch (error) {
      console.warn(`[level-tap] cannot measure ${element.currentSrc}: ${String(error)}`);
      unmeasurable.set(element, element.currentSrc);
      return null;
    }
    // Only its sound: a captured picture would copy every frame.
    for (const track of captured.getVideoTracks()) track.stop();
    const sound = captured.getAudioTracks();
    if (!sound.length) {
      // Before its metadata there is no telling yet; after it, the file has no sound.
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) unmeasurable.set(element, element.currentSrc);
      return null;
    }
    // An output of none: this context only listens (Electron 44 takes it; it is not in TypeScript's DOM yet).
    context ??= new AudioContext({ sinkId: { type: "none" } } as AudioContextOptions);
    if (context.state !== "running") void context.resume();
    const stream = new MediaStream(sound);
    const source = context.createMediaStreamSource(stream);
    // Mono on both sides and more than two channels folded to two: what the speakers make of it.
    const stereo = new GainNode(context, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
    const splitter = context.createChannelSplitter(2);
    source.connect(stereo).connect(splitter);
    const analysers = [0, 1].map((channel) => {
      const analyser = new AnalyserNode(context!, { fftSize: WINDOW_SAMPLES });
      splitter.connect(analyser, channel);
      return analyser;
    });
    return { stream, nodes: [source, stereo, splitter, ...analysers], analysers };
  };

  const close = (tap: Tap): void => {
    for (const node of tap.nodes) node.disconnect();
    for (const track of tap.stream.getTracks()) track.stop();
  };

  const peakDb = (analyser: AnalyserNode): number => {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  };

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const tap of taps.values()) close(tap);
    taps.clear();
    void context?.suspend();
  };

  const tick = (): void => {
    const level: TapLevel = [-Infinity, -Infinity];
    const sounding = new Set<HTMLMediaElement>();
    for (const element of elements()) {
      if (!audible(element) || unmeasurable.get(element) === element.currentSrc) continue;
      sounding.add(element);
      let tap = taps.get(element) ?? null;
      if (!tap) {
        tap = open(element);
        if (!tap) continue;
        taps.set(element, tap);
      }
      // The copy is the sound before the element's volume (measured, Electron 44: −12 dBFS at volume 1 and 0.5).
      const gain = 20 * Math.log10(element.volume);
      level[0] = Math.max(level[0], peakDb(tap.analysers[0]!) + gain);
      level[1] = Math.max(level[1], peakDb(tap.analysers[1]!) + gain);
    }
    for (const [element, tap] of taps) {
      if (sounding.has(element)) continue;
      close(tap);
      taps.delete(element);
    }
    if (sounding.size || sounded) send(level);
    sounded = sounding.size > 0;
    if (!sounded) stop();
  };

  const wake = (): void => {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    tick();
  };
  // A copy goes silent for good once its element is muted or at volume 0, even after it sounds again (measured,
  // Electron 44): the tap goes the moment that happens, never a tick later, so the next one is a new copy. Media events
  // do not bubble, but they reach the document's capture phase: any element, from anywhere.
  const onMedia = (event: Event): void => {
    const element = event.target;
    const tap = element instanceof HTMLMediaElement && !audible(element) ? taps.get(element) : undefined;
    if (tap) {
      close(tap);
      taps.delete(element as HTMLMediaElement);
    }
    wake();
  };
  const events = ["play", "playing", "pause", "volumechange"] as const;
  for (const event of events) document.addEventListener(event, onMedia, true);
  // An element already playing when this starts (a projector rebuilt mid-song).
  wake();
  return () => {
    for (const event of events) document.removeEventListener(event, onMedia, true);
    stop();
    void context?.close();
  };
}
