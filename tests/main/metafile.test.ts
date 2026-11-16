/**
 * `metafileToSvg` — EMF and WMF pictures as standalone SVG.
 *
 * Every metafile here is written by the test, record by record from [MS-EMF]/[MS-WMF], so the
 * suite shares no code with the players. Real metafiles are third-party and stay out of the repo:
 * the corpus run (`tools/release-checks/pptx-render/`, maintainer side) is what compares the
 * result with PowerPoint's own rendering.
 */
import { crc32, deflateSync, gzipSync, inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { metafileToSvg } from "../../src/main/slides/pptx/metafile";

// -- EMF ------------------------------------------------------------------------------------------

/** One EMF record: type, size, then 32-bit little-endian words (or raw bytes). */
function emr(type: number, ...fields: (number | Buffer)[]): Buffer {
  const body = Buffer.concat(
    fields.map((f) => {
      if (Buffer.isBuffer(f)) return f;
      const b = Buffer.alloc(4);
      b.writeInt32LE(f | 0);
      return b;
    }),
  );
  const head = Buffer.alloc(8);
  head.writeUInt32LE(type, 0);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** A 100 × 100 mm picture on a 100 × 100 px reference device: one device pixel per millimetre,
 *  so the SVG's viewBox is 0 0 100 100 and logical units are device pixels. */
function emf(...records: Buffer[]): Buffer {
  const header = emr(
    1,
    ...[0, 0, 99, 99], // rclBounds, device pixels
    ...[0, 0, 10000, 10000], // rclFrame, 0.01 mm
    0x464d4520, // " EMF"
    0x10000,
    0, // nBytes, patched below
    records.length + 2,
    4, // nHandles + reserved
    0, // nDescription
    0, // offDescription
    0, // nPalEntries
    ...[100, 100], // szlDevice
    ...[100, 100], // szlMillimeters
  );
  const file = Buffer.concat([header, ...records, emr(14, 0, 16, 20)]);
  file.writeUInt32LE(file.length, 48);
  return file;
}

const colorRef = (rgb: number): number => ((rgb >> 16) & 0xff) | (rgb & 0xff00) | ((rgb & 0xff) << 16);

/** 16-bit coordinate pairs packed as the 32-bit words `emr` takes. */
function points16(...xy: number[]): Buffer {
  const b = Buffer.alloc(xy.length * 2);
  xy.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}

function logFontW(face: string, height: number, weight = 400): Buffer {
  const b = Buffer.alloc(92);
  b.writeInt32LE(height, 0);
  b.writeInt32LE(weight, 16);
  b.write(face, 28, "utf16le");
  return b;
}

/** A 2 × 2, 24-bit, bottom-up DIB: rows are stored bottom first, BGR, padded to 4 bytes. */
function dib24(): { info: Buffer; bits: Buffer } {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(2, 4);
  info.writeInt32LE(2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  // bottom row: blue, white; top row: red, green
  const bits = Buffer.from([0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0xff, 0, 0xff, 0, 0, 0]);
  return { info, bits };
}

/** The pixels of a truecolour PNG produced by the converter (Sub-filtered, as it writes them). */
function pngPixels(href: string): { width: number; height: number; rgb: number[] } {
  const png = Buffer.from(href.slice(href.indexOf(",") + 1), "base64");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    expect(raw[row]).toBe(1);
    const line: number[] = [];
    for (let i = 0; i < width * channels; i += 1) line.push((raw[row + 1 + i]! + (i >= channels ? line[i - channels]! : 0)) & 0xff);
    for (let x = 0; x < width; x += 1) rgb.push((line[x * channels]! << 16) | (line[x * channels + 1]! << 8) | line[x * channels + 2]!);
  }
  return { width, height, rgb };
}

/** An EMF+ record: type, flags, size, data size, data (already 4-byte aligned here). */
function plus(type: number, flags: number, data: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(flags, 2);
  head.writeUInt32LE(12 + data.length, 4);
  head.writeUInt32LE(data.length, 8);
  return Buffer.concat([head, data]);
}

/** EMR_COMMENT carrying EMF+ records: its data size, the "EMF+" signature, the records. */
function emfPlus(...records: Buffer[]): Buffer {
  const body = Buffer.concat(records);
  return emr(70, body.length + 4, 0x2b464d45, body);
}

/** A 1 × 1 truecolour PNG, written by hand. */
function png1x1(rgb: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const row = Buffer.from([0, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff]);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(row)), chunk("IEND", Buffer.alloc(0))]);
}

describe("EMF", () => {
  test("a rectangle in a pen and a brush, in device space under the frame's viewBox", () => {
    const svg = metafileToSvg(
      emf(
        emr(38, 1, 0, 2, 0, colorRef(0xff0000)), // CREATEPEN: solid, 2 wide, red
        emr(39, 2, 0, colorRef(0x0000ff), 0), // CREATEBRUSHINDIRECT: solid blue
        emr(37, 1),
        emr(37, 2),
        emr(43, 10, 10, 50, 40), // RECTANGLE
      ),
      "emf",
    );
    expect(svg).toContain('viewBox="0 0 100 100" preserveAspectRatio="none"');
    // GDI walks a rectangle counter-clockwise on screen.
    expect(svg).toContain('<path d="M10 10L10 40L50 40L50 10Z" fill="#0000ff" fill-rule="evenodd" stroke="#ff0000" stroke-width="2"');
  });

  test("a polygon under an anisotropic mapping, a null brush and a cosmetic pen", () => {
    const svg = metafileToSvg(
      emf(
        emr(17, 8), // SETMAPMODE anisotropic
        emr(9, 1000, 1000), // window extent
        emr(11, 100, 100), // viewport extent: 10 logical units per pixel
        emr(37, 0x80000005), // NULL_BRUSH
        emr(86, 0, 0, 0, 0, 3, points16(100, 100, 900, 100, 500, 800)), // POLYGON16
      ),
      "emf",
    );
    expect(svg).toContain('d="M10 10L90 10L50 80Z" fill="none" stroke="#000000" stroke-width="1" vector-effect="non-scaling-stroke"');
  });

  test("a text run placed by its dx array, from the baseline", () => {
    const text = Buffer.from("Hi", "utf16le");
    const svg = metafileToSvg(
      emf(
        emr(82, 1, logFontW("Arial", -20, 700)), // EXTCREATEFONTINDIRECTW
        emr(37, 1),
        emr(24, colorRef(0x336699)), // SETTEXTCOLOR
        emr(22, 24), // SETTEXTALIGN: TA_BASELINE
        emr(18, 1), // SETBKMODE: TRANSPARENT
        // EXTTEXTOUTW: bounds, GM_COMPATIBLE, scales, then EMRTEXT with the string at 76, dx at 80.
        emr(84, 0, 0, 0, 0, 1, 0, 0, 30, 60, 2, 76, 0, 0, 0, 0, 0, 80, text, 12, 15),
      ),
      "emf",
    );
    expect(svg).toContain('<g transform="matrix(1 0 0 1 30 60)">');
    expect(svg).toMatch(/<text x="0 12" y="0" font-family="'Arial', 'Liberation Sans', sans-serif" font-size="20" font-weight="700"[^>]* fill="#336699"[^>]*>Hi<\/text>/);
  });

  test("a 24-bit DIB stretched over the destination as a PNG data URI, top row first", () => {
    const { info, bits } = dib24();
    // STRETCHDIBITS: bounds, dest x y, src x y w h, bmi/bits offsets and sizes, usage, rop, dest w h.
    const svg = metafileToSvg(emf(emr(81, 0, 0, 0, 0, 20, 30, 0, 0, 2, 2, 80, 40, 120, 16, 0, 0xcc0020, 40, 20, info, bits)), "emf")!;
    expect(svg).toContain('<image width="2" height="2" preserveAspectRatio="none" transform="matrix(20 0 0 10 20 30)"');
    const href = /href="([^"]+)"/.exec(svg)![1]!;
    expect(href.startsWith("data:image/png;base64,")).toBe(true);
    expect(pngPixels(href)).toEqual({ width: 2, height: 2, rgb: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff] });
  });

  test("a gzipped picture (.emz) draws as the plain one", () => {
    const plain = emf(emr(43, 10, 10, 50, 40));
    expect(metafileToSvg(gzipSync(plain), "emf")).toBe(metafileToSvg(plain, "emf"));
  });

  test("EMF+ only, with nothing for GDI to draw, is refused rather than shown empty", () => {
    const comment = (dual: number): Buffer => emfPlus(plus(0x4001, dual, Buffer.alloc(16)), plus(0x400a, 0, Buffer.alloc(24)));
    expect(metafileToSvg(emf(comment(0)), "emf")).toBeNull();
    expect(metafileToSvg(emf(comment(1), emr(43, 10, 10, 50, 40)), "emf")).toContain("<path");
  });

  test("an EMF+ picture is drawn from its own PNG, and its GDI fallback is skipped", () => {
    const png = png1x1(0x00ff00);
    const image = Buffer.alloc(28);
    image.writeUInt32LE(0xdbc01002, 0); // version
    image.writeUInt32LE(1, 4); // bitmap
    image.writeUInt32LE(1, 24); // compressed: a whole PNG follows
    const draw = Buffer.alloc(40);
    draw.writeUInt32LE(0xffffffff, 0); // no image attributes
    draw.writeInt32LE(2, 4); // source unit: pixels
    draw.writeFloatLE(1, 16); // source rectangle 0 0 1 1
    draw.writeFloatLE(1, 20);
    draw.writeUInt32LE(3, 24);
    [10, 20, 60, 20, 10, 50].forEach((v, i) => draw.writeInt16LE(v, 28 + i * 2)); // UL, UR, LL
    const { info, bits } = dib24();
    const svg = metafileToSvg(
      emf(
        emfPlus(plus(0x4001, 1, Buffer.alloc(16))),
        // Object 0, an image; DrawImagePoints of it with 16-bit points (flag C).
        emfPlus(plus(0x4008, 0x0500, Buffer.concat([image, png])), plus(0x401b, 0x4000, draw)),
        emr(81, 0, 0, 0, 0, 10, 20, 0, 0, 2, 2, 80, 40, 120, 16, 0, 0xcc0020, 50, 30, info, bits), // the fallback
        emfPlus(plus(0x4002, 0, Buffer.alloc(0))),
        emr(43, 10, 10, 50, 40), // GDI again, drawn
      ),
      "emf",
    )!;
    expect(svg.match(/<image /g)).toHaveLength(1);
    expect(svg).toContain(`transform="matrix(50 0 0 30 10 20)" href="data:image/png;base64,${png.toString("base64")}"`);
    expect(svg).toContain('<path d="M10 10L10 40L50 40L50 10Z"');
  });
});

// -- WMF ------------------------------------------------------------------------------------------

/** One WMF record: size in 16-bit words, function, then signed 16-bit parameters (or bytes). */
function meta(fn: number, ...params: (number | Buffer)[]): Buffer {
  const body = Buffer.concat(
    params.map((p) => {
      if (Buffer.isBuffer(p)) return p;
      const b = Buffer.alloc(2);
      b.writeUInt16LE(p & 0xffff);
      return b;
    }),
  );
  const head = Buffer.alloc(6);
  head.writeUInt32LE((6 + body.length) / 2, 0);
  head.writeUInt16LE(fn, 4);
  return Buffer.concat([head, body]);
}

function wmf(placeable: boolean, ...records: Buffer[]): Buffer {
  const header = Buffer.alloc(18);
  header.writeUInt16LE(1, 0); // memory metafile
  header.writeUInt16LE(9, 2); // header size in words
  header.writeUInt16LE(0x300, 4);
  const body = Buffer.concat([header, ...records, meta(0)]);
  if (!placeable) return body;
  const aldus = Buffer.alloc(22);
  aldus.writeUInt32LE(0x9ac6cdd7, 0);
  aldus.writeInt16LE(0, 6);
  aldus.writeInt16LE(0, 8);
  aldus.writeInt16LE(200, 10);
  aldus.writeInt16LE(100, 12);
  aldus.writeUInt16LE(1440, 14);
  return Buffer.concat([aldus, body]);
}

const colorRefWords = (rgb: number): [number, number] => {
  const ref = colorRef(rgb);
  return [ref & 0xffff, ref >>> 16];
};

describe("WMF", () => {
  test("the window is the picture: a rectangle in a pen and a brush, a polygon", () => {
    const svg = metafileToSvg(
      wmf(
        true,
        meta(0x020b, 0, 0), // SETWINDOWORG y, x
        meta(0x020c, 100, 200), // SETWINDOWEXT y, x
        meta(0x02fa, 0, 3, 0, ...colorRefWords(0x00ff00)), // CREATEPENINDIRECT: solid, 3 wide, green → slot 0
        meta(0x02fc, 0, ...colorRefWords(0xffcc00), 0), // CREATEBRUSHINDIRECT: solid → slot 1
        meta(0x012d, 0),
        meta(0x012d, 1),
        meta(0x041b, 90, 150, 10, 20), // RECTANGLE bottom, right, top, left
        meta(0x0106, 2), // SETPOLYFILLMODE: winding
        meta(0x0324, 3, 0, 0, 100, 0, 50, 50), // POLYGON
      ),
      "wmf",
    );
    expect(svg).toContain('width="13.333" height="6.667" viewBox="0 0 200 100" preserveAspectRatio="none"');
    expect(svg).toContain('<path d="M20 10L20 90L150 90L150 10Z" fill="#ffcc00" fill-rule="evenodd" stroke="#00ff00" stroke-width="3"');
    expect(svg).toContain('<path d="M0 0L100 0L50 50Z" fill="#ffcc00" stroke="#00ff00" stroke-width="3"');
  });

  test("a window whose y extent is negative turns the picture right side up", () => {
    const svg = metafileToSvg(
      wmf(false, meta(0x020b, 100, 0), meta(0x020c, -100, 200), meta(0x0324, 3, 10, 90, 20, 90, 15, 80)),
      "wmf",
    );
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain('d="M10 10L20 10L15 20Z"');
  });

  test("TEXTOUT and EXTTEXTOUT in the font's code page, aligned to the cell top by default", () => {
    const font = Buffer.alloc(50);
    font.writeInt16LE(-20, 0);
    font.writeInt16LE(400, 8);
    font.writeUInt8(204, 13); // RUSSIAN_CHARSET: Windows-1251
    font.write("Arial", 18, "latin1");
    const text = Buffer.from([0xcf, 0xf0, 0xe8]); // "При" in Windows-1251
    const svg = metafileToSvg(
      wmf(
        false,
        meta(0x020c, 100, 200),
        meta(0x02fb, font), // CREATEFONTINDIRECT → slot 0
        meta(0x012d, 0),
        meta(0x0102, 1), // SETBKMODE: transparent
        meta(0x0521, 3, Buffer.concat([text, Buffer.alloc(1)]), 40, 10), // TEXTOUT: length, string, y, x
        meta(0x0a32, 70, 10, 3, 0, Buffer.concat([text, Buffer.alloc(1)]), 11, 11, 11), // EXTTEXTOUT with dx
      ),
      "wmf",
    )!;
    // TA_TOP: the baseline is the font's ascent (Arial: 0.905 em) below the reference point.
    expect(svg).toContain('<g transform="matrix(1 0 0 1 10 40)"><text x="0" y="18.1"');
    expect(svg).toContain('<text x="0 11 22" y="18.1"');
    expect(svg.match(/>При<\/text>/g)).toHaveLength(2);
  });
});

// 2026-11-15 audit, S3: this runs in main, per request and per window, and gunzipped with no cap (255 KB of
// `.emz` gave 256 MB). A raster in a metafile's clothes is what turns those bytes into an SVG, so it is the probe.
test("a gzipped metafile that inflates past 64 MB is refused, not inflated", () => {
  const png = Buffer.from("\x89PNG", "latin1");
  const bomb = gzipSync(Buffer.concat([png, Buffer.alloc(80 * 1024 * 1024)]), { level: 9 });
  expect(bomb.length).toBeLessThan(1024 * 1024);
  const t0 = performance.now();
  expect(metafileToSvg(bomb, "emf")).toBeNull();
  expect(performance.now() - t0).toBeLessThan(500);
  // The cap is far above a real one: the same raster at 1 MB still comes back.
  expect(metafileToSvg(gzipSync(Buffer.concat([png, Buffer.alloc(1024 * 1024)])), "emf")).toContain("data:image/png;base64,");
});

describe("what is not a metafile", () => {
  test("garbage, nothing at all and a truncated header are null, never a throw", () => {
    expect(metafileToSvg(Buffer.from("not a metafile at all, just some text"), "emf")).toBeNull();
    expect(metafileToSvg(new Uint8Array(0), "wmf")).toBeNull();
    expect(metafileToSvg(emf().subarray(0, 60), "emf")).toBeNull();
    expect(metafileToSvg(Buffer.from([0x1f, 0x8b, 1, 2, 3]), "emf")).toBeNull();
  });

  test("a record that claims more bytes than the file has ends the picture, not the conversion", () => {
    const file = emf(emr(43, 10, 10, 50, 40));
    const cut = file.subarray(0, file.length - 30);
    expect(metafileToSvg(cut, "emf")).toContain("<svg");
  });
});
