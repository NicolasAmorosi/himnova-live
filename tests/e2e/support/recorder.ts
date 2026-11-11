import fs from "node:fs";
import path from "node:path";
import type { CDPSession, Locator, Page } from "@playwright/test";
import { layOut } from "./demo";

/** A point or a box in the control window's CSS pixels. */
type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/**
 * Everything a tutorial video is made of, in seconds from the start: the frames
 * each window painted (screencast, so both share one clock), where the pointer
 * was, each click and key, each caption, and what the camera should frame. The
 * video itself is composed outside the app from this file.
 */
export type Timeline = {
  control: { width: number; height: number; scale: number };
  frames: { control: { t: number; file: string }[]; projector: { t: number; file: string }[] };
  cursor: ({ t: number } & Point)[];
  clicks: ({ t: number } & Point)[];
  keys: { t: number; key: string }[];
  /** Each drag: from pressing to releasing, and the box of what was dragged (the video draws its copy under the pointer). */
  drags: { t0: number; t1: number; box: Box }[];
  captions: { t: number; text: string }[];
  focus: { t: number; box: Box | null }[];
  end: number;
};

const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/**
 * Drives the control window the way a person would — the pointer glides, a
 * click waits a beat, text is typed key by key — and records it. `npm run
 * tutorials` only: nothing here checks the app.
 */
export class Recorder {
  private t0 = 0;
  private at: Point;
  private readonly raw = {
    frames: { control: [] as { t: number; file: string }[], projector: [] as { t: number; file: string }[] },
    cursor: [] as ({ t: number } & Point)[],
    clicks: [] as ({ t: number } & Point)[],
    keys: [] as { t: number; key: string }[],
    drags: [] as { t0: number; t1: number; box: Box }[],
    captions: [] as { t: number; text: string }[],
    focus: [] as { t: number; box: Box | null }[],
  };
  private readonly casts: CDPSession[] = [];

  private constructor(
    readonly dir: string,
    readonly page: Page,
    readonly size: { width: number; height: number; scale: number },
  ) {
    this.at = { x: size.width * 0.55, y: size.height * 0.6 };
  }

  /** Lays the control window out at `size` and starts filming it into `dir` (emptied first). */
  static async start(dir: string, page: Page, size = { width: 1440, height: 900, scale: 2 }): Promise<Recorder> {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const recorder = new Recorder(dir, page, size);
    const cdp = await layOut(page, size.width, size.height, size.scale);
    await page.mouse.move(recorder.at.x, recorder.at.y);
    await sleep(400);
    recorder.t0 = now();
    recorder.raw.cursor.push({ t: recorder.t0, ...recorder.at });
    await recorder.cast("control", cdp, size.width * size.scale, size.height * size.scale);
    return recorder;
  }

  /** Films the projector too, from the moment it opens, at its own size: an emulated size doesn't
   *  survive the app placing the window. On a 16:10 laptop screen 16:9 content is letterboxed in it,
   *  so the video crops it back to 16:9. */
  async projector(page: Page): Promise<void> {
    await this.cast("projector", await page.context().newCDPSession(page), 1280, 720);
  }

  private async cast(window: "control" | "projector", cdp: CDPSession, maxWidth: number, maxHeight: number): Promise<void> {
    let n = 0;
    cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
      const file = `${window}-${String(n++).padStart(5, "0")}.jpg`;
      fs.writeFileSync(path.join(this.dir, file), Buffer.from(data, "base64"));
      this.raw.frames[window].push({ t: metadata.timestamp ?? now(), file });
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 88,
      everyNthFrame: window === "control" ? 2 : 1,
      maxWidth,
      maxHeight,
    });
    this.casts.push(cdp);
  }

  /** Shows `text` as the caption from now on (`**label**` in bold) and gives it time to be read. */
  async say(text: string, extraMs = 0): Promise<void> {
    this.raw.captions.push({ t: now(), text });
    await sleep(900 + extraMs);
  }

  /** Waits so the viewer can follow what just happened. */
  async hold(ms = 1200): Promise<void> {
    await sleep(ms);
  }

  /** Points the camera at `target` (with some room around it), or back at the whole window. */
  async focus(target: Locator | Box | null, pad = 24): Promise<void> {
    const box = target === null ? null : "x" in target ? target : await target.boundingBox();
    this.raw.focus.push({
      t: now(),
      box: box && { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad },
    });
  }

  /** Glides the pointer to `target`'s centre. */
  async glide(target: Locator | Point, ms = 650): Promise<void> {
    const to = "x" in target ? target : await center(target);
    const from = this.at;
    const steps = Math.max(10, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      this.at = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      await this.page.mouse.move(this.at.x, this.at.y);
      this.raw.cursor.push({ t: now(), ...this.at });
      await sleep(ms / steps);
    }
  }

  /** Glides to `target` and clicks it, a beat after arriving. */
  async click(target: Locator, options: { double?: boolean } = {}): Promise<void> {
    await this.glide(target);
    await sleep(180);
    this.raw.clicks.push({ t: now(), ...this.at });
    if (options.double) await target.dblclick({ position: await this.local(target) });
    else await target.click({ position: await this.local(target) });
    await sleep(350);
  }

  /** Drags `source` to `target` (a locator's centre or a point) the way a hand does: press, move, release. */
  async drag(source: Locator, target: Locator | Point): Promise<void> {
    const box = await source.boundingBox();
    if (!box) throw new Error("the drag source is not on screen");
    await this.glide(source);
    await sleep(250);
    const t0 = now();
    await this.page.mouse.down();
    await this.glide({ x: this.at.x + 10, y: this.at.y + 6 }, 150);
    await this.glide(target, 1200);
    await sleep(250);
    await this.page.mouse.up();
    this.raw.drags.push({ t0, t1: now(), box });
    await sleep(500);
  }

  /** Clicks into `target` and types `text` key by key. */
  async type(target: Locator, text: string): Promise<void> {
    await this.click(target);
    await target.pressSequentially(text, { delay: 110 });
    await sleep(300);
  }

  /** Presses `key`, shown on screen as `label`. */
  async press(key: string, label = key): Promise<void> {
    this.raw.keys.push({ t: now(), key: label });
    await this.page.keyboard.press(key);
    await sleep(500);
  }

  /** Stops filming and writes `timeline.json`: every time relative to the start. */
  async finish(): Promise<Timeline> {
    await sleep(600);
    const end = now();
    if (process.env["TUTORIAL_DEBUG"]) await this.page.screenshot({ path: path.join(this.dir, "final-control.png") });
    for (const cdp of this.casts) await cdp.send("Page.stopScreencast").catch(() => undefined);
    const rel = <T extends { t: number }>(items: T[]) => items.map((item) => ({ ...item, t: Math.max(0, item.t - this.t0) }));
    const timeline: Timeline = {
      control: this.size,
      frames: { control: rel(this.raw.frames.control), projector: rel(this.raw.frames.projector) },
      cursor: rel(this.raw.cursor),
      clicks: rel(this.raw.clicks),
      keys: rel(this.raw.keys),
      drags: this.raw.drags.map((d) => ({ ...d, t0: Math.max(0, d.t0 - this.t0), t1: Math.max(0, d.t1 - this.t0) })),
      captions: rel(this.raw.captions),
      focus: rel(this.raw.focus),
      end: end - this.t0,
    };
    fs.writeFileSync(path.join(this.dir, "timeline.json"), JSON.stringify(timeline));
    return timeline;
  }

  /** Where the pointer is, relative to `target` (so Playwright clicks right under it). */
  private async local(target: Locator): Promise<Point> {
    const box = await target.boundingBox();
    if (!box) throw new Error("the target is not on screen");
    return { x: this.at.x - box.x, y: this.at.y - box.y };
  }
}

async function center(target: Locator): Promise<Point> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("the target is not on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
