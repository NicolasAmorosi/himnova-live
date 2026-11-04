import fs from "node:fs";
import path from "node:path";
import type { AssetKind } from "../../src/shared/constants";
import type { MediaAsset } from "../../src/shared/types/media";
import { fixture } from "./support/paths";
import { expect, relaunch, test, type WorshipApp } from "./support/app";

/**
 * The «Ordenar» menu of the media tabs, over the «Biblioteca» view:
 * every order on every tab, kept per tab and across a restart, combined with
 * the search box, with files added or edited afterwards, from the keyboard, on
 * a long virtualized library and in a Windows-sized window.
 *
 * Three files per tab whose name, date and size orders are all different, so
 * each of the six orders is its own permutation and an order that silently
 * does nothing — or sorts by the wrong field — cannot pass.
 */

type Tab = "Videos" | "Imágenes" | "Audios" | "Presentaciones";
type Order = "Nombre (A → Z)" | "Nombre (Z → A)" | "Más nuevo primero" | "Más viejo primero" | "Más grande primero" | "Más chico primero";

const TABS: { tab: Tab; kind: AssetKind }[] = [
  { tab: "Videos", kind: "video" },
  { tab: "Imágenes", kind: "image" },
  { tab: "Audios", kind: "audio" },
  { tab: "Presentaciones", kind: "ppt" },
];

const day = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

/** A = «Ángel» (accented, must not sort past Z), B = «Himno 2», C = «Himno 10»
 *  (numeric collation: 2 before 10). Date: A newest, C middle, B oldest. Size:
 *  B biggest, A middle, C smallest. Six orders, six different permutations. */
const EXPECTED: Record<Order, string[]> = {
  "Nombre (A → Z)": ["Ángel", "Himno 2", "Himno 10"],
  "Nombre (Z → A)": ["Himno 10", "Himno 2", "Ángel"],
  "Más nuevo primero": ["Ángel", "Himno 10", "Himno 2"],
  "Más viejo primero": ["Himno 2", "Himno 10", "Ángel"],
  "Más grande primero": ["Himno 2", "Ángel", "Himno 10"],
  "Más chico primero": ["Himno 10", "Ángel", "Himno 2"],
};

/** Each one differs from the one before it, so a click that changes nothing fails. */
const CYCLE: Order[] = [
  "Más nuevo primero",
  "Más viejo primero",
  "Más grande primero",
  "Más chico primero",
  "Nombre (Z → A)",
  "Nombre (A → Z)",
];

/** Grows a copy to `size` bytes in a way its format ignores: a `free` atom for
 *  an MP4, trailing bytes for a PNG or an MP3. Decks are not padded — their
 *  three fixtures already differ in size. */
function padTo(file: string, size: number): void {
  const extra = size - fs.statSync(file).size;
  if (extra <= 0) return;
  if (file.endsWith(".mp4")) {
    const box = Buffer.alloc(extra);
    box.writeUInt32BE(extra, 0);
    box.write("free", 4, "ascii");
    fs.appendFileSync(file, box);
  } else {
    fs.appendFileSync(file, Buffer.alloc(extra));
  }
}

type Seed = { name: string; from: string; size?: number; mtime: Date };

/** Copies under the test's profile with the given name, size and mtime. */
function writeSeed(app: WorshipApp, kind: AssetKind, seed: Seed): string {
  const ext = path.extname(seed.from);
  const target = path.join(app.profile, "media-src", kind, `${seed.name}${ext}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fixture(seed.from), target);
  if (seed.size !== undefined) padTo(target, seed.size);
  fs.utimesSync(target, seed.mtime, seed.mtime);
  return target;
}

function seedsFor(kind: AssetKind): Seed[] {
  // Added C, B, A: the database's own order is Z → A, so a grid that ignored
  // the setting would already fail the default A → Z.
  if (kind === "ppt") {
    return [
      { name: "Himno 10", from: "deck.pdf", mtime: day("2025-06-01") }, // 1 KB
      { name: "Himno 2", from: "clipdeck.pptx", mtime: day("2019-01-01") }, // 200 KB
      { name: "Ángel", from: "hymn.pptx", mtime: day("2026-03-01") }, // 11 KB
    ];
  }
  const from = { video: "clip.mp4", image: "photo.png", audio: "song.mp3" }[kind];
  const base = fs.statSync(fixture(from)).size;
  return [
    { name: "Himno 10", from, mtime: day("2025-06-01") },
    { name: "Himno 2", from, size: base + 300_000, mtime: day("2019-01-01") },
    { name: "Ángel", from, size: base + 100_000, mtime: day("2026-03-01") },
  ];
}

async function seedKind(app: WorshipApp, kind: AssetKind): Promise<void> {
  for (const seed of seedsFor(kind)) {
    await app.invoke<MediaAsset[]>("library:add", { kind, paths: [writeSeed(app, kind, seed)] });
  }
}

const panel = (app: WorshipApp, tab: Tab) => app.control.getByRole("tabpanel", { name: tab });

/** What the grid shows, in reading order: each tile's `title` is its file
 *  name. By position, not DOM order — `VirtualGrid` keeps the row holding the
 *  tab stop mounted after the window it is scrolled to. */
const tileNames = (app: WorshipApp, tab: Tab) =>
  panel(app, tab)
    .getByRole("list")
    .getByRole("button")
    .evaluateAll((tiles) =>
      tiles
        .map((tile) => ({ rect: tile.getBoundingClientRect(), title: tile.getAttribute("title") }))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .map(({ title }) => title),
    );

async function pickOrder(app: WorshipApp, tab: Tab, order: Order): Promise<void> {
  await panel(app, tab).getByRole("button", { name: "Ordenar" }).click();
  await app.control.getByRole("menuitemradio", { name: order }).click();
  await expect(app.control.getByRole("menu", { name: "Ordenar" })).toHaveCount(0);
}

/** The order the menu says is in effect — opened, read, closed with Escape. */
async function checkedOrder(app: WorshipApp, tab: Tab): Promise<string | null> {
  await panel(app, tab).getByRole("button", { name: "Ordenar" }).click();
  const checked = app.control.getByRole("menuitemradio", { checked: true });
  await expect(checked).toHaveCount(1);
  const name = await checked.textContent();
  await app.control.keyboard.press("Escape");
  await expect(app.control.getByRole("menu", { name: "Ordenar" })).toHaveCount(0);
  return name?.trim() ?? null;
}

async function expectRecentView(app: WorshipApp, tab: Tab): Promise<void> {
  await expect(panel(app, tab).getByRole("button", { name: "Biblioteca", exact: true })).toHaveAttribute("aria-pressed", "true");
}

for (const { tab, kind } of TABS) {
  test(`${tab}: each of the six orders sorts «Biblioteca»`, async ({ app }) => {
    await seedKind(app, kind);
    await app.openResources("Media", tab);
    await expectRecentView(app, tab);

    // A new install starts in A → Z.
    await expect.poll(() => tileNames(app, tab)).toEqual(EXPECTED["Nombre (A → Z)"]);
    expect(await checkedOrder(app, tab)).toBe("Nombre (A → Z)");

    for (const order of CYCLE) {
      await pickOrder(app, tab, order);
      await expect.poll(() => tileNames(app, tab), { message: order }).toEqual(EXPECTED[order]);
      expect(await checkedOrder(app, tab)).toBe(order);
    }
  });
}

test("each tab keeps its own order, and every one of them survives a restart", async ({ app }) => {
  const chosen: Record<Tab, Order> = {
    Videos: "Más nuevo primero",
    Imágenes: "Más grande primero",
    Audios: "Nombre (Z → A)",
    Presentaciones: "Más viejo primero",
  };
  for (const { kind } of TABS) await seedKind(app, kind);
  for (const { tab } of TABS) {
    await app.openResources("Media", tab);
    await pickOrder(app, tab, chosen[tab]);
  }
  // Going back over the tabs: none of them was reset by the next one's choice.
  for (const { tab } of TABS) {
    await app.openResources("Media", tab);
    await expect.poll(() => tileNames(app, tab), { message: tab }).toEqual(EXPECTED[chosen[tab]]);
  }

  await app.quit();
  const again = await relaunch(app);
  for (const { tab } of TABS) {
    await again.openResources("Media", tab);
    await expectRecentView(again, tab);
    await expect.poll(() => tileNames(again, tab), { message: tab }).toEqual(EXPECTED[chosen[tab]]);
    expect(await checkedOrder(again, tab)).toBe(chosen[tab]);
  }
});

test("the search narrows the sorted list without reordering it, and clearing it keeps the order", async ({ app }) => {
  await seedKind(app, "image");
  await app.openResources("Media", "Imágenes");
  await pickOrder(app, "Imágenes", "Más nuevo primero");

  const search = panel(app, "Imágenes").getByRole("textbox", { name: "Buscar por nombre…" });
  await search.fill("himno");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["Himno 10", "Himno 2"]);
  // Changing the order with a filter up re-sorts what is left.
  await pickOrder(app, "Imágenes", "Más grande primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["Himno 2", "Himno 10"]);
  await expect(search).toHaveValue("himno");

  await search.press("Escape");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más grande primero"]);
});

test("a file added after an order was chosen lands in its sorted place", async ({ app }) => {
  await seedKind(app, "image");
  await app.openResources("Media", "Imágenes");
  await pickOrder(app, "Imágenes", "Más nuevo primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más nuevo primero"]);

  // Through the real «Agregar» button and its native dialog.
  const newest = writeSeed(app, "image", { name: "Bautismo", from: "photo.png", mtime: day("2026-10-01") });
  await app.answerOpenDialog(newest);
  await panel(app, "Imágenes").getByRole("button", { name: "Agregar", exact: true }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["Bautismo", ...EXPECTED["Más nuevo primero"]]);

  const oldest = writeSeed(app, "image", { name: "Antiguo", from: "photo.png", mtime: day("2001-01-01") });
  await app.answerOpenDialog(oldest);
  await panel(app, "Imágenes").getByRole("button", { name: "Agregar", exact: true }).click();
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["Bautismo", ...EXPECTED["Más nuevo primero"], "Antiguo"]);

  await pickOrder(app, "Imágenes", "Nombre (A → Z)");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(["Ángel", "Antiguo", "Bautismo", "Himno 2", "Himno 10"]);
});

test("«Más nuevo primero» goes by the file's own date, not by when it was added", async ({ app }) => {
  await seedKind(app, "image");
  // Added last of all, but its file is from 2010 — a hymn copied off an old
  // pendrive, which Explorer and Finder both copy keeping its date.
  const copiedToday = writeSeed(app, "image", { name: "Recién agregado", from: "photo.png", mtime: day("2010-05-05") });
  await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths: [copiedToday] });
  await app.openResources("Media", "Imágenes");
  await pickOrder(app, "Imágenes", "Más nuevo primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual([...EXPECTED["Más nuevo primero"], "Recién agregado"]);
});

test("a file edited on disk moves to its new place once the library is swept", async ({ app }) => {
  await seedKind(app, "image");
  await app.openResources("Media", "Imágenes");
  await pickOrder(app, "Imágenes", "Más nuevo primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más nuevo primero"]);
  await app.quit();

  // Edited while the app was closed: the oldest file becomes the newest.
  const edited = path.join(app.profile, "media-src", "image", "Himno 2.png");
  fs.utimesSync(edited, day("2026-10-20"), day("2026-10-20"));

  const again = await relaunch(app);
  await again.openResources("Media", "Imágenes");
  await expect.poll(() => tileNames(again, "Imágenes"), { timeout: 15_000 }).toEqual(["Himno 2", "Ángel", "Himno 10"]);
});

test("the menu works from the keyboard and never sends anything live", async ({ app }) => {
  await seedKind(app, "video");
  await app.openResources("Media", "Videos");
  const trigger = panel(app, "Videos").getByRole("button", { name: "Ordenar" });

  await trigger.focus();
  await app.control.keyboard.press("ArrowDown");
  // Opens on the order in effect.
  await expect(app.control.getByRole("menuitemradio", { name: "Nombre (A → Z)" })).toBeFocused();
  await app.control.keyboard.press("ArrowDown"); // Z → A
  await app.control.keyboard.press("ArrowDown"); // Más nuevo primero
  await app.control.keyboard.press("Enter");
  await expect(app.control.getByRole("menu", { name: "Ordenar" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => tileNames(app, "Videos")).toEqual(EXPECTED["Más nuevo primero"]);

  await app.control.keyboard.press("ArrowDown");
  await app.control.keyboard.press("End"); // Más chico primero
  await app.control.keyboard.press("Space");
  await expect.poll(() => tileNames(app, "Videos")).toEqual(EXPECTED["Más chico primero"]);

  // Escape leaves the order alone.
  await app.control.keyboard.press("ArrowDown");
  await app.control.keyboard.press("Home");
  await app.control.keyboard.press("Escape");
  await expect.poll(() => tileNames(app, "Videos")).toEqual(EXPECTED["Más chico primero"]);

  // None of those Enters or Spaces reached the projector.
  expect(app.electron.windows().some((page) => page.url().endsWith("/projection.html"))).toBe(false);
});

test("the selected file stays selected, and is the one added to the program, after re-sorting", async ({ app }) => {
  await seedKind(app, "image");
  await app.openResources("Media", "Imágenes");
  const tile = panel(app, "Imágenes").getByRole("button", { name: "Himno 2" });
  await tile.click();
  await expect(tile).toHaveAttribute("aria-current", "true");

  await pickOrder(app, "Imágenes", "Más grande primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más grande primero"]);
  await expect(tile).toHaveAttribute("aria-current", "true");
  await expect(panel(app, "Imágenes").locator('[aria-current="true"]')).toHaveCount(1);

  await panel(app, "Imágenes").getByRole("button", { name: "Agregar al programa" }).click();
  await expect(app.control.getByRole("main").getByRole("list").first().getByRole("listitem")).toHaveText([/Himno 2/]);
});

/** 150 images, «Himno 1» … «Himno 150»; name order and date order are
 *  opposite — «Himno 1» is the newest file. */
async function seedHymnal(app: WorshipApp): Promise<void> {
  const paths: string[] = [];
  for (let n = 1; n <= 150; n += 1) {
    paths.push(writeSeed(app, "image", { name: `Himno ${n}`, from: "photo.png", mtime: new Date(Date.UTC(2026, 0, 1) - n * 86_400_000) }));
  }
  await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths });
}

/** Scrolls the grid's scrolling ancestor (`PanelBody`). */
const scrollTo = (app: WorshipApp, tab: Tab, where: "top" | "bottom") =>
  panel(app, tab)
    .getByRole("list")
    .evaluate((el, w) => {
      let node = el.parentElement;
      while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
      if (node) node.scrollTop = w === "top" ? 0 : node.scrollHeight;
    }, where);

/** The first tile the operator can actually see. */
const firstVisible = (app: WorshipApp, tab: Tab) =>
  panel(app, tab)
    .getByRole("list")
    .evaluate((el) => {
      let node = el.parentElement;
      while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
      const top = node?.getBoundingClientRect().top ?? 0;
      return (
        [...el.querySelectorAll("[title]")]
          .map((tile) => ({ rect: tile.getBoundingClientRect(), title: tile.getAttribute("title") }))
          .filter(({ rect }) => rect.bottom > top + 1)
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.title ?? null
      );
    });

test("a long library sorts across the whole virtualized grid", async ({ app }) => {
  await seedHymnal(app);
  await app.openResources("Media", "Imágenes");

  const firstAndLast = async () => {
    const scroll = (where: "top" | "bottom") => scrollTo(app, "Imágenes", where);
    await scroll("top");
    await expect.poll(async () => (await tileNames(app, "Imágenes"))[0]).toBeTruthy();
    const first = (await tileNames(app, "Imágenes"))[0];
    await scroll("bottom");
    await app.control.waitForTimeout(150);
    const last = (await tileNames(app, "Imágenes")).at(-1);
    return [first, last];
  };

  await expect.poll(firstAndLast).toEqual(["Himno 1", "Himno 150"]);
  await pickOrder(app, "Imágenes", "Nombre (Z → A)");
  await expect.poll(firstAndLast).toEqual(["Himno 150", "Himno 1"]);
  await pickOrder(app, "Imágenes", "Más viejo primero");
  await expect.poll(firstAndLast).toEqual(["Himno 150", "Himno 1"]);
  await pickOrder(app, "Imágenes", "Más nuevo primero");
  await expect.poll(firstAndLast).toEqual(["Himno 1", "Himno 150"]);
});

test("scrolled to the bottom, a new order or a new search starts at its first file", async ({ app }) => {
  await seedHymnal(app);
  await app.openResources("Media", "Imágenes");
  await expect.poll(() => firstVisible(app, "Imágenes")).toBe("Himno 1");

  await scrollTo(app, "Imágenes", "bottom");
  await expect.poll(() => firstVisible(app, "Imágenes")).not.toBe("Himno 1");
  await pickOrder(app, "Imágenes", "Nombre (Z → A)");
  // Not «Himno 9»: the tail of the new order is not what the operator asked to see.
  await expect.poll(() => firstVisible(app, "Imágenes")).toBe("Himno 150");

  await scrollTo(app, "Imágenes", "bottom");
  await panel(app, "Imágenes").getByRole("textbox", { name: "Buscar por nombre…" }).fill("himno 1");
  await expect.poll(() => firstVisible(app, "Imágenes")).toBe("Himno 150");
});

test("a linked folder and «Biblioteca» share the tab's order", async ({ app }) => {
  await seedKind(app, "image");
  const folder = path.join(app.profile, "media-src", "image");
  await app.openResources("Media", "Imágenes");
  await pickOrder(app, "Imágenes", "Más grande primero");

  await app.answerOpenDialog(folder);
  await panel(app, "Imágenes").getByRole("button", { name: "Vincular carpeta" }).click();
  await expect(panel(app, "Imágenes").getByRole("button", { name: folder })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más grande primero"]);

  await pickOrder(app, "Imágenes", "Más viejo primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más viejo primero"]);
  await panel(app, "Imágenes").getByRole("button", { name: "Biblioteca", exact: true }).click();
  await expectRecentView(app, "Imágenes");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(EXPECTED["Más viejo primero"]);
});

test("names sort ignoring case and accents, and files sharing a date fall back to the name", async ({ app }) => {
  // A folder copied in one go: every file with the same date.
  const same = day("2024-04-04");
  const paths = ["zeta", "Alba", "éxodo", "beta", "Coro"].map((name) =>
    writeSeed(app, "image", { name, from: "photo.png", mtime: same }),
  );
  await app.invoke<MediaAsset[]>("library:add", { kind: "image", paths });
  await app.openResources("Media", "Imágenes");

  const byName = ["Alba", "beta", "Coro", "éxodo", "zeta"];
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(byName);
  await pickOrder(app, "Imágenes", "Más nuevo primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(byName);
  await pickOrder(app, "Imágenes", "Más viejo primero");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual(byName);
  await pickOrder(app, "Imágenes", "Nombre (Z → A)");
  await expect.poll(() => tileNames(app, "Imágenes")).toEqual([...byName].reverse());
});

test("at the smallest window the app allows, the menu fits and every option can be picked", async ({ app }) => {
  // Asked smaller than `minWidth`/`minHeight` (control-window.ts): the window
  // stops at its minimum, which is the tightest the panel ever gets.
  await app.electron.evaluate(({ BrowserWindow }) => {
    const control = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("/index.html"));
    control?.setFullScreen(false);
    control?.unmaximize();
    control?.setContentSize(800, 500);
  });
  // 1000 is the window's, frame included: Windows' borders leave 984 inside.
  await expect.poll(() => app.control.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1000);
  const viewportHeight = await app.control.evaluate(() => window.innerHeight);

  await seedKind(app, "ppt");
  await app.openResources("Media", "Presentaciones");
  for (const order of CYCLE) {
    await panel(app, "Presentaciones").getByRole("button", { name: "Ordenar" }).click();
    const menu = app.control.getByRole("menu", { name: "Ordenar" });
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight);
    await app.control.getByRole("menuitemradio", { name: order }).click();
    await expect.poll(() => tileNames(app, "Presentaciones"), { message: order }).toEqual(EXPECTED[order]);
  }
});
