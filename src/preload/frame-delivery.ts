/** What `setSharedTextureReceiver` hands over, as far as delivering a frame goes. */
interface ReceivedTexture {
  getVideoFrame(): VideoFrame;
  release(): void;
}

/**
 * Hands one media-engine frame to every listener of its key. The texture goes back to the engine
 * whatever happens: its ring has six slots, and one never released is one the engine waits on. A
 * listener that throws is logged and the next one still gets the frame.
 */
export function deliverFrame(listeners: ReadonlySet<(frame: VideoFrame) => void> | undefined, texture: ReceivedTexture): void {
  try {
    if (!listeners?.size) return;
    const frame = texture.getVideoFrame();
    try {
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (error) {
          console.error("[preload] a video frame listener failed", error);
        }
      }
    } finally {
      frame.close();
    }
  } finally {
    texture.release();
  }
}
