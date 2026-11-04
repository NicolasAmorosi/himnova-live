import { registerHandlers, type Handlers } from "./register";
import { displaysHandlers } from "./handlers/displays";
import { projectionHandlers } from "./handlers/projection";
import { filesHandlers } from "./handlers/files";
import { slidesHandlers } from "./handlers/slides";
import { bibleHandlers } from "./handlers/bible";
import { libraryHandlers } from "./handlers/library";
import { programsHandlers } from "./handlers/programs";
import { settingsHandlers } from "./handlers/settings";
import { programDraftHandlers } from "./handlers/program-draft";
import { utilityHandlers } from "./handlers/utility";
import { overlaysHandlers } from "./handlers/overlays";
import { songsHandlers } from "./handlers/songs";
import { systemHandlers } from "./handlers/system";
import { engineAssetsHandlers } from "./handlers/engine-assets";
import { updatesHandlers } from "./handlers/updates";
import { previewHandlers } from "./handlers/preview";

/**
 * Assembling the object literal AS `Handlers` is what makes a missing or
 * mis-typed channel a compile error — TypeScript checks every key of
 * IpcContract is present with the right signature at this single call site.
 */
export function registerAllIpcHandlers(): void {
  const handlers: Handlers = {
    ...displaysHandlers,
    ...projectionHandlers,
    ...filesHandlers,
    ...slidesHandlers,
    ...bibleHandlers,
    ...libraryHandlers,
    ...programsHandlers,
    ...settingsHandlers,
    ...programDraftHandlers,
    ...utilityHandlers,
    ...overlaysHandlers,
    ...songsHandlers,
    ...systemHandlers,
    ...engineAssetsHandlers,
    ...updatesHandlers,
    ...previewHandlers,
  };
  registerHandlers(handlers);
}
