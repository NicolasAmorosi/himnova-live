import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { mt } from "../i18n";

/** NOT `app.name`: that is package.json's `name` ("worship-app" — electron-builder
 *  never ships `build.productName`), and it cannot be changed with
 *  `app.setName()` because it also names the userData folder. See
 *  `.claude/knowledge/electron-userdata-follows-package-name-not-build-productname.md`. */
const PRODUCT_NAME = "Himnova Live";

/**
 * The app's own menu, replacing Electron's default one.
 *
 * Not cosmetic — the default menu ships two accelerators this app cannot
 * afford:
 *
 *   - **Cmd/Ctrl+W (Window -> Close).** It closes whichever window has focus,
 *     and the projection window is a window: one stray Cmd+W in a dark booth
 *     took the projector down mid-service. There is no Close item here at all;
 *     the control window is closed from the OS chrome, and Cmd+Q still quits.
 *   - **Cmd/Ctrl+R and Shift+Cmd/Ctrl+R (View -> Reload / Force Reload).**
 *     A reload restarts the renderer. The draft autosave now survives that,
 *     but an operator has no reason to reach it, so the whole development
 *     block is packaged-build-only.
 *
 * Labels come from main's own dictionary (`main/i18n/`): the renderer's
 * cannot serve, a menu is built before any window exists. Changing the
 * language calls this again (`ipc/handlers/settings.ts`).
 *
 * **No menu at all on Windows** (the operator's call, 2026-10-18). There it is
 * a bar inside the window, and a stray Alt gives it the keyboard: the next
 * arrows and Enter walk the menu instead of the slides. Nothing in it is
 * needed there — Chromium handles copy, paste and undo in a text field on its
 * own, and the window's X quits — and no menu also means none of the default
 * accelerators above.
 */
export function installApplicationMenu(): void {
  if (process.platform === "win32") {
    Menu.setApplicationMenu(null);
    return;
  }
  const isMac = process.platform === "darwin";

  /** Only in a development build — see the note above. */
  const developmentItems: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [
        { type: "separator" },
        { role: "reload", label: mt("menu.reload") },
        { role: "forceReload", label: mt("menu.forceReload") },
        { role: "toggleDevTools", label: mt("menu.devTools") },
      ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: "about", label: mt("menu.about", { app: PRODUCT_NAME }) },
              { type: "separator" },
              { role: "services", label: mt("menu.services") },
              { type: "separator" },
              { role: "hide", label: mt("menu.hide", { app: PRODUCT_NAME }) },
              { role: "hideOthers", label: mt("menu.hideOthers") },
              { role: "unhide", label: mt("menu.showAll") },
              { type: "separator" },
              { role: "quit", label: mt("menu.quitApp", { app: PRODUCT_NAME }) },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: mt("menu.edit"),
      submenu: [
        { role: "undo", label: mt("menu.undo") },
        { role: "redo", label: mt("menu.redo") },
        { type: "separator" },
        { role: "cut", label: mt("menu.cut") },
        { role: "copy", label: mt("menu.copy") },
        { role: "paste", label: mt("menu.paste") },
        { role: "selectAll", label: mt("menu.selectAll") },
      ],
    },
    {
      label: mt("menu.view"),
      submenu: [
        { role: "resetZoom", label: mt("menu.actualSize") },
        { role: "zoomIn", label: mt("menu.zoomIn") },
        { role: "zoomOut", label: mt("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: mt("menu.fullScreen") },
        ...developmentItems,
      ],
    },
    {
      label: mt("menu.window"),
      submenu: [
        { role: "minimize", label: mt("menu.minimize") },
        ...(isMac
          ? ([
              { role: "zoom", label: mt("menu.zoom") },
              { type: "separator" },
              { role: "front", label: mt("menu.bringAllToFront") },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    ...(isMac
      ? []
      : ([
          {
            label: mt("menu.file"),
            submenu: [{ role: "quit", label: mt("menu.quit") }],
          },
        ] satisfies MenuItemConstructorOptions[])),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
