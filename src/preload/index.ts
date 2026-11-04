import { contextBridge, ipcRenderer, sharedTexture, webUtils, type IpcRendererEvent } from "electron";

/**
 * Deliberately generic (invoke/on/send by string channel), not a 28-method
 * object enumerating every domain — that would be a THIRD place the contract
 * gets written out (after shared/ipc/contract.ts and the main handlers). This
 * file never needs to change when a channel is added or removed.
 *
 * This isn't an open door: `ipcRenderer.invoke` to a channel with no
 * `ipcMain.handle` registered simply rejects. The real attack surface is
 * defined by which handlers main registers (src/main/ipc/index.ts), not by
 * this bridge being generic.
 *
 * `getPathForFile` is the one deliberate exception to "generic invoke/on
 * only": since Electron 32, `File.path` no longer exists (removed for
 * security), so resolving a filesystem path from a `File` dropped from the
 * OS requires `webUtils.getPathForFile`, which only runs in a renderer/
 * preload context — it cannot be modeled as a main-process IPC channel.
 *
 * `onVideoFrame` is the second one, for the same reason: a frame of the media
 * engine (src/main/media/media-engine.ts) is a GPU texture, and it only
 * arrives through Electron's shared-texture receiver, which lives here. Main
 * sends each frame with the key of what it shows (`liveEngineFrameKey`,
 * `previewEngineFrameKey` in `shared/urls.ts`).
 * The callback gets its own `VideoFrame` and must `close()` it once drawn —
 * synchronously: the engine reuses the texture as soon as it is released.
 */
const frameListeners = new Map<string, Set<(frame: VideoFrame) => void>>();

sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, key: unknown) => {
  const listeners = typeof key === "string" ? frameListeners.get(key) : undefined;
  if (listeners?.size) {
    const frame = importedSharedTexture.getVideoFrame();
    try {
      for (const listener of listeners) listener(frame);
    } finally {
      frame.close();
    }
  }
  importedSharedTexture.release();
  return Promise.resolve();
});

const bridge = {
  invoke: (channel: string, req: unknown) => ipcRenderer.invoke(channel, req),

  on: (channel: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  onVideoFrame: (key: string, callback: (frame: VideoFrame) => void): (() => void) => {
    let listeners = frameListeners.get(key);
    if (!listeners) frameListeners.set(key, (listeners = new Set()));
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};

export type WorshipBridge = typeof bridge;

contextBridge.exposeInMainWorld("worship", bridge);
