// The preload is type-checked by both programs, and the node one has no DOM types. A media-engine
// frame (`onVideoFrame`) only needs this much of WebCodecs' VideoFrame here; the renderer sees DOM's.
interface VideoFrame {
  close(): void;
}
