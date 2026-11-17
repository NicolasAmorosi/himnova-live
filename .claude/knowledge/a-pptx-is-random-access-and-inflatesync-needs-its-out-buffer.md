## A `.pptx` never has to be read whole to get its XML, and each entry is inflated capped at the size it declares
**Area:** slides
**Trigger:** touching `readEntries`/`readPresentationMeta`/`extractAudioParts` in `src/main/slides/pptx-metadata.ts`, `extractHintFromOoxml` in `src/main/slides/linked-audio.ts`, `src/main/slides/zip-reader.ts`, or any new use of `fflate` on a deck.

- **fflate's `filter` option does not save the read, only the inflate.** `unzipSync(buf, { filter })`
  takes a **buffer**, so using it means `fs.readFileSync` of the entire archive first. The old
  comment on `readEntries` ("decompresses only the entries we actually read — important on a 200 MB
  deck where the media parts should stay compressed") was true and beside the point: the 200 MB were
  already read and allocated, synchronously, on the thread that serves the projection window. The
  filter only skipped inflating them.
- **A zip is random-access on purpose.** The end-of-central-directory record says where the central
  directory is; the central directory says where every entry starts and how big it is. So the XML
  parts of a `.pptx` are reachable in kilobytes regardless of how much media surrounds them. That is
  what `src/main/slides/zip-reader.ts` (`readZipEntries`) does, and it is why it could stay
  **synchronous**: the reads are small, so no caller had to become `async` — `readPresentationMeta`,
  `extractAudioParts`, `extractHintFromOoxml`, `MediaRepo.ensureLinkedAudio` and `toDeckDTO` all kept
  their signatures. Going async there would have cascaded through the whole deck-DTO path for no gain.
- **The naive version of that is slower, and the reason is not syscalls.** One read per entry over
  118 parts of a 3 MB archive measured **2.9 ms vs 0.9 ms** for `readFileSync`+`unzipSync` — and
  coalescing the reads into a single windowed read barely moved it (2.6 ms). Profiling isolated it:
  **120 `inflateSync` calls cost 1.9 ms, while fflate's own internal path did the same 120 entries in
  0.47 ms.** `inflateSync(data)` with no options has to guess the output size and grow its buffer;
  `unzipSync` doesn't, because the central directory already told it the uncompressed size. Passing
  it explicitly — `inflateSync(raw, { out: new Uint8Array(uncompressedSize) })` — removed the whole
  gap (final: 0.3 ms, i.e. 2.7× *faster* than reading the file whole). `Buffer.alloc` for the read
  window was the other avoidable cost; it zero-fills megabytes, so `allocUnsafe` is correct there.
- **Consequence.** Never reach for `unzipSync`/`readFileSync` on a deck again: go through
  `readZipEntries`. And remember the measurement discipline that found this: the first two "obvious"
  optimizations (offsets, then coalescing reads) both looked like regressions until the profile said
  the cost was in the decompressor's allocation strategy, not in I/O at all.
- **2026-11-15 (audit, S7): fflate's `out` is not a cap, so the inflate moved to zlib.** Given an
  `out` shorter than the stream, `inflateSync` neither throws nor stops: it decodes the WHOLE stream
  and keeps what fits. A fabricated part declaring 1000 bytes over a 3 GB stream cost 15 s of main,
  and an honest part whose directory understated it came back cut, in silence. `inflateEntry` is now
  `zlib.inflateRawSync(raw, { maxOutputLength })` with the declared size as the cap: past it zlib
  stops and throws, and the entry is skipped as corrupt. The declared size only ever comes from the
  central directory (a data-descriptor entry has its real sizes there too), so a declared 0 is an
  empty part, never an unknown one. It is also faster than fflate with `out` (5.0 against 15.4 ms
  over 800 small parts), and the result is copied out because zlib returns a view of its own 64 KB
  chunk. A future entry-reading path does the same: cap the inflate, never trust a short `out`.
- Verified with a differential harness against `unzipSync`, byte for byte, over 622 checks: deflate /
  stored / zip64 / trailing-comment archives, four real `.pptx`, and ~150 legacy binary `.pps` (which
  both implementations must reject). Plus `npm run slides:smoke` on a 22.9 MB `.pptx` and on a
  `.pps` that resolves a linked `.mp3`.
- The legacy binary `.ppt`/`.pps` branch of the same problem — which is *not* a zip and genuinely
  does need bounded chunked scanning — is a separate finding: see
  [prewarm-lru-grace-and-linked-audio-full-file-read.md](prewarm-lru-grace-and-linked-audio-full-file-read.md).

**Last updated:** 2026-11-15
