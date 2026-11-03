import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import type { AssetKind } from "../../../src/shared/constants";
import type { MediaAsset } from "../../../src/shared/types/media";
import { ROOT, fixture } from "./paths";

/**
 * The launch flags from the CDP recipe
 * (`.claude/knowledge/occluded-electron-window-has-no-rendering-lifecycle.md`):
 * without them a control window hidden behind the fullscreen projector stops
 * rendering, and input reaches it seconds late.
 */
const FLAGS = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  // Every test starts a new profile, and a new profile starts in the OS's
  // language (`main/i18n/system-locale.ts`): pinned, so the suite reads the
  // same Spanish on any machine.
  "--lang=es",
  // Against the packaged app the launch check would reach GitHub in every
  // test. The update suite serves its own feed and asks by hand, or turns it
  // back on with `test.use({ launchCheck: true })`.
  "--no-update-check",
];

/** What the renderer's global handlers log before showing the "error
 *  inesperado" toast (`lib/global-error-handlers.ts`), plus main's crash path.
 *  Any of these in a run is a bug, whatever the test was checking. */
const UNEXPECTED = [/\[renderer\] unhandled rejection/, /\[renderer\] uncaught error/, /\[uncaughtException\]/];

export class WorshipApp {
  /** Resolves when the process is gone. Tracked here because Playwright
   *  disposes `electron.process()` along with the app once it has exited. */
  readonly exited: Promise<void>;
  private hasExited = false;

  private constructor(
    readonly electron: ElectronApplication,
    readonly control: Page,
    readonly profile: string,
    readonly log: string[],
    /** Electron main's own pid. Not `electron.process().pid`: on Windows Playwright
     *  starts the app through `cmd.exe`, and killing that left the app alive. */
    readonly mainPid: number,
  ) {
    this.exited = new Promise((resolve) =>
      electron.process().once("exit", () => {
        this.hasExited = true;
        resolve();
      }),
    );
  }

  /** Starts the built app on `profile`, an empty directory for a first launch
   *  or a previous run's for a relaunch. */
  static async launch(profile: string, launchCheck = false): Promise<WorshipApp> {
    // `WORSHIP_E2E_EXECUTABLE` runs the suite against an INSTALLED build
    // (`release/mac-arm64/Lumina Live.app/Contents/MacOS/Lumina Live`, or
    // `Lumina Live.exe` on the church PC) instead of `electron .` on `out/`:
    // what ships resolves FFmpeg, the migrations and the bibles from the
    // package's own `resources/`, which only a packaged run exercises.
    const executable = process.env["WORSHIP_E2E_EXECUTABLE"];
    const flags = launchCheck ? FLAGS.filter((flag) => flag !== "--no-update-check") : FLAGS;
    const app = await electron.launch({
      cwd: ROOT,
      ...(executable
        ? { executablePath: executable, args: [`--user-data-dir=${profile}`, ...flags] }
        : { args: [ROOT, `--user-data-dir=${profile}`, ...flags] }),
      // Sends every renderer `console.*` to stderr, so the log has both sides.
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    });
    const log: string[] = [];
    const collect = (chunk: Buffer) => log.push(...String(chunk).split("\n").filter((line) => line.trim() !== ""));
    app.process().stdout?.on("data", collect);
    app.process().stderr?.on("data", collect);

    const control = await app.firstWindow();
    await expect(control.getByRole("button", { name: "EN VIVO", exact: true })).toBeVisible();
    return new WorshipApp(app, control, profile, log, await app.evaluate(() => process.pid));
  }

  /** An IPC call through the same bridge the UI uses. For SETUP only — what a
   *  test checks goes through the real UI (native dialogs are the reason this
   *  exists: CDP cannot drive them). */
  async invoke<T>(channel: string, req?: unknown): Promise<T> {
    type Bridge = { worship: { invoke: (channel: string, req: unknown) => Promise<unknown> } };
    const result = await this.control.evaluate(
      ([c, r]) => (window as unknown as Bridge).worship.invoke(c, r),
      [channel, req] as const,
    );
    const typed = result as { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
    if (!typed.ok) throw new Error(`${channel} → ${typed.error.code}: ${typed.error.message}`);
    return typed.data;
  }

  /** Adds generated fixtures to the library, as "Agregar" would. */
  addMedia(kind: AssetKind, ...names: string[]): Promise<MediaAsset[]> {
    return this.invoke<MediaAsset[]>("library:add", { kind, paths: names.map(fixture) });
  }

  /**
   * Answers the NEXT native open dialog with `filePaths` (or a cancel, with
   * none), so a test can press the real «Agregar», «Elegir archivo…» or
   * «Importar versión» button. Every dialog of the app goes through
   * `dialog.showOpenDialog` (`main/ipc/open-dialog.ts`); this swaps it for one
   * call and puts the original back.
   */
  async answerOpenDialog(...filePaths: string[]): Promise<void> {
    await this.electron.evaluate(({ dialog }, paths) => {
      const original = dialog.showOpenDialog.bind(dialog);
      dialog.showOpenDialog = () => {
        dialog.showOpenDialog = original;
        return Promise.resolve({ canceled: paths.length === 0, filePaths: paths });
      };
    }, filePaths);
  }

  /** The right-hand column: the LIVE monitor and everything that controls
   *  what is on the projector. */
  liveColumn(): Locator {
    return this.control.locator("section").filter({ has: this.control.getByRole("heading", { name: "En Vivo" }) });
  }

  /** The centre column: PREVIEW and its grid. */
  previewColumn(): Locator {
    return this.control.locator("section").filter({ has: this.control.getByRole("heading", { name: "Preview" }) });
  }

  /** The top bar's EN VIVO, which every kind of content shares. (A plate's
   *  own row carries a second one, and so does a time scene's.) */
  goLive(): Promise<void> {
    return this.control.getByRole("button", { name: "EN VIVO", exact: true }).first().click();
  }

  /** A resource tab, and one of its inner tabs. */
  async openResources(
    tab: "Biblia" | "Media" | "Funciones",
    inner?: "Videos" | "Imágenes" | "Audios" | "Presentaciones" | "Utilidades" | "Overlays",
  ): Promise<void> {
    await this.control.getByRole("tab", { name: tab }).click();
    if (inner) await this.control.getByRole("tab", { name: inner }).click();
  }

  /** Loads a chapter in the Bible tab the way an operator does — typed, then
   *  Enter — waiting for the match first: on a cold start the book list loads
   *  after the window, and an Enter with nothing to pick is ignored. */
  async openChapter(reference: string): Promise<void> {
    await this.openResources("Biblia");
    const panel = this.control.getByRole("tabpanel", { name: "Biblia" });
    await panel.getByRole("textbox", { name: "Buscar libro y capítulo…" }).fill(reference);
    await expect(panel.getByRole("listitem").filter({ hasText: new RegExp(`^${reference}$`) })).toBeVisible();
    await this.control.keyboard.press("Enter");
  }

  /** Clicks a library tile: PREVIEW only. */
  async previewFile(inner: "Videos" | "Imágenes" | "Audios" | "Presentaciones", name: string): Promise<void> {
    await this.openResources("Media", inner);
    await this.control.getByRole("tabpanel", { name: inner }).getByRole("button", { name }).first().click();
  }

  /** The projection window. It only exists once something went live. */
  async projector(): Promise<Page> {
    const open = this.electron.windows().find((page) => page.url().endsWith("/projection.html"));
    const page =
      open ??
      (await this.electron.waitForEvent("window", { predicate: (p) => p.url().endsWith("/projection.html") }));
    await page.waitForLoadState("domcontentloaded");
    return page;
  }

  hasProjector(): boolean {
    return this.electron.windows().some((page) => page.url().endsWith("/projection.html"));
  }

  unexpectedErrors(): string[] {
    return this.log.filter((line) => UNEXPECTED.some((pattern) => pattern.test(line)));
  }

  /**
   * A real quit, the way ⌘Q / closing the window does it: through
   * `before-quit` and the close guard. `answer` is what to do if the control
   * window asks first («Cerrar igualmente» or «Cancelar»); with "cancel" the
   * app must stay alive, so this resolves once the question is answered.
   */
  async quit(answer: "close" | "cancel" = "close"): Promise<void> {
    const exited = this.exited;
    await this.electron.evaluate(({ app }) => app.quit());
    // Only the close guard's own question: Ajustes or Programas may still be
    // open, and a slow machine shows those before the process is gone.
    const dialog = this.control.getByRole("dialog", { name: /^¿Cerrar/ });
    const asked = dialog.waitFor({ state: "visible", timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    if (await Promise.race([exited.then(() => false), asked])) {
      if (answer === "cancel") {
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        await expect(dialog).toBeHidden();
        return;
      }
      // The answer ends the process, which can take the page down before the
      // click returns («Target page, context or browser has been closed», seen
      // on Linux). A click that failed for any other reason never exits, below.
      await dialog
        .getByRole("button", { name: "Cerrar igualmente" })
        .click()
        .catch(() => undefined);
    }
    await exited;
  }

  /**
   * Teardown: ends the process without asking anything. Bounded, because once
   * in a few dozen runs the process outlived `app.exit(0)` and the worker hung
   * for minutes with nothing to show: now a stuck process gets sampled into
   * this app's log, SIGKILLed, and the test fails saying so.
   */
  async kill(): Promise<void> {
    if (this.hasExited) return;
    const within = (promise: Promise<unknown>, ms: number) =>
      Promise.race([promise.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))]);
    const answered = await within(this.electron.evaluate(({ app }) => app.exit(0)).catch(() => undefined), 5_000);
    if (await within(this.exited, 10_000)) return;
    this.log.push(`[e2e] the app did not exit (app.exit ${answered ? "answered" : "never answered"})`, sampleOf(this.mainPid));
    process.kill(this.mainPid, "SIGKILL");
    await this.exited;
    throw new Error("the app did not exit within 15 s of app.exit(0) — its sample is at the end of app.log");
  }
}

/** Where a stuck process is, for the log: `sample` on macOS, the bare process
 *  line elsewhere. */
function sampleOf(pid: number): string {
  try {
    return process.platform === "darwin"
      ? execFileSync("sample", [String(pid), "2"], { encoding: "utf8" })
      : execFileSync("ps", ["-o", "pid,stat,etime,command", "-p", String(pid)], { encoding: "utf8" });
  } catch (error) {
    return `(no sample: ${String(error)})`;
  }
}

/** The video elements of a window, as numbers a test can compare. */
export function videoStates(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("video")].map((video) => ({
      src: video.currentSrc || video.src,
      currentTime: video.currentTime,
      /** Where playback actually began (`played`), or `null` before any frame
       *  played. Not `currentTime`: `play()` flips `paused` at readyState 0,
       *  when `currentTime` still reads 0 for a video whose mount-time seek
       *  has not landed yet. */
      playedFrom: video.played.length > 0 ? video.played.start(0) : null,
      paused: video.paused,
      videoWidth: video.videoWidth,
      readyState: video.readyState,
      volume: video.volume,
      muted: video.muted,
      opacity: Number(getComputedStyle(video).opacity),
    })),
  );
}

/** The media engine's canvases of a window (`EngineVideo`), by the key their
 *  frames come under: the size the last frame gave them, and a sample of their
 *  pixels, which moves while the video plays and stands still while it does not. */
export function engineStates(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-frame-key]")].map((canvas) => {
      let sample = 0;
      if (canvas.width > 0) {
        const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
        for (let i = 0; i < pixels.length; i += 4099) sample += pixels[i] ?? 0;
      }
      return {
        key: canvas.dataset.frameKey ?? "",
        width: canvas.width,
        sample,
        opacity: Number(getComputedStyle(canvas).opacity),
      };
    }),
  );
}

/** The engine canvas whose frames come under a key starting with `prefix`. */
export async function engineCanvas(page: Page, prefix: string) {
  return (await engineStates(page)).find((state) => state.key.startsWith(prefix)) ?? null;
}

/** Whether that canvas's picture changes over 400 ms: the video is playing. */
export async function moving(page: Page, prefix: string): Promise<boolean> {
  const before = await engineCanvas(page, prefix);
  await page.waitForTimeout(400);
  const after = await engineCanvas(page, prefix);
  return before !== null && after !== null && before.width > 0 && before.sample !== after.sample;
}

export function audioStates(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("audio")].map((audio) => ({
      src: audio.currentSrc || audio.src,
      currentTime: audio.currentTime,
      paused: audio.paused,
      readyState: audio.readyState,
      volume: audio.volume,
    })),
  );
}

type Fixtures = { app: WorshipApp; profileDir: string; launchCheck: boolean };

export const test = base.extend<Fixtures>({
  /** Whether `app` runs main's update check ten seconds after launch. */
  launchCheck: [false, { option: true }],
  // A fresh profile per test, removed afterwards. Playwright requires the
  // destructuring pattern even for a fixture that needs no other fixture.
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  profileDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-e2e-profile-"));
    await use(dir);
    // Up to ~11 s: on a loaded 4-CPU Linux box a child of the app still being
    // torn down after `app.exit(0)` was seen writing in the profile while it
    // was removed (`ENOTEMPTY` after 5 retries, the test itself had passed).
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },

  app: async ({ profileDir, launchCheck }, use, testInfo) => {
    const app = await WorshipApp.launch(profileDir, launchCheck);
    await use(app);
    // Whatever app the test ended with — it may have relaunched — is the one
    // registered last; tests that relaunch call `adopt` below.
    const current = adopted.get(testInfo.testId) ?? app;
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [index, page] of current.electron.windows().entries()) {
        const file = testInfo.outputPath(`window-${index}-${path.basename(page.url())}.png`);
        if (await page.screenshot({ path: file }).catch(() => null)) await testInfo.attach(path.basename(file), { path: file });
      }
    }
    // Killed before the log is attached: a stuck exit writes its sample there.
    const exit = await Promise.all([current.kill(), app.kill()]).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    await testInfo.attach("app.log", { body: [...app.log, ...(current === app ? [] : current.log)].join("\n") });
    const errors = [...app.unexpectedErrors(), ...(current === app ? [] : current.unexpectedErrors())];
    if (exit) throw exit;
    expect(errors, "the app logged an unexpected error").toEqual([]);
  },
});

const adopted = new Map<string, WorshipApp>();

/** For a test that quits and relaunches: makes teardown clean up (and check)
 *  the new instance too. */
export async function relaunch(app: WorshipApp): Promise<WorshipApp> {
  const next = await WorshipApp.launch(app.profile);
  adopted.set(test.info().testId, next);
  return next;
}

export { expect };
