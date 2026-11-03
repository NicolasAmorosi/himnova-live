/**
 * What a deck's bytes are — the sniffs that decide which reader opens it, and,
 * when none can, what to tell the operator.
 *
 * `containerKind` routes a source to the picture reader or the model reader
 * (OOXML, a legacy binary, ODF) — or, for a PDF, to the rasterizer: a PDF
 * classified as anything else would be handed to a model reader that can't
 * read it. `sniffUnreadableDeck` names why a deck every reader declined won't
 * open. Both go by the magic bytes rather than the extension, so these tests
 * give fixtures the *wrong* extension where that is the point.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { ASSET_EXTENSIONS } from "../../src/shared/constants";
import { containerKind } from "../../src/main/slides/pptx-metadata";
import { sniffUnreadableDeck } from "../../src/main/slides/ppt-binary";
import { buildLegacyPpt, compoundFile } from "../fixtures/legacy-ppt";

let tmpDir: string;

function write(name: string, bytes: Uint8Array | Buffer): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worship-container-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("containerKind", () => {
  test("recognizes a PDF by its %PDF header", () => {
    const file = write("deck.pdf", Buffer.from("%PDF-1.7\n%\xb5\xb5\xb5\xb5\n1 0 obj\n", "latin1"));
    expect(containerKind(file)).toBe("pdf");
  });

  test("goes by the magic bytes, not the extension", () => {
    // Both directions: a PDF named like a presentation must still be
    // rasterized, and a real deck named `.pdf` must not be handed to the
    // rasterizer as one.
    const misnamedPdf = write("actually-a-pdf.pptx", Buffer.from("%PDF-1.4\n", "latin1"));
    expect(containerKind(misnamedPdf)).toBe("pdf");

    const misnamedDeck = write(
      "actually-a-deck.pdf",
      zipSync({ "ppt/presentation.xml": strToU8("<p:presentation/>") }),
    );
    expect(containerKind(misnamedDeck)).toBe("ooxml");
  });

  test("still classifies OOXML and legacy binaries", () => {
    const ooxml = write("deck.pptx", zipSync({ "ppt/presentation.xml": strToU8("<p:presentation/>") }));
    expect(containerKind(ooxml)).toBe("ooxml");

    // A `.pdf` is four bytes of ASCII and OLE2 is four bytes of binary — near
    // misses, so this pins that one is not read as the other.
    const ole2 = write("deck.pps", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    expect(containerKind(ole2)).toBe("binary");

    const odf = write("deck.odp", zipSync({ "content.xml": strToU8("<office/>") }));
    expect(containerKind(odf)).toBe("odf");
  });

  test("a file too short to sniff is unknown, not a crash", () => {
    expect(containerKind(write("empty.pptx", Buffer.alloc(0)))).toBe("unknown");
    expect(containerKind(path.join(tmpDir, "does-not-exist.pptx"))).toBe("unknown");
  });

  test("a PDF is a deck, not a kind of its own", () => {
    // The whole design rests on this: everything downstream keys on
    // `kind === "ppt"` to mean "this is a deck".
    expect(ASSET_EXTENSIONS.ppt).toContain("pdf");
    expect(ASSET_EXTENSIONS.image).not.toContain("pdf");
  });
});

describe("sniffUnreadableDeck", () => {
  const stream = (name: string, bytes = 64) => ({ name, data: Buffer.alloc(bytes, 1) });
  /** A PowerPoint 97 `Current User` stream with this header token. */
  const currentUser = (token: number) => {
    const data = Buffer.alloc(32);
    data.writeUInt16LE(0x0ff6, 2);
    data.writeUInt32LE(0x14, 8);
    data.writeUInt32LE(token, 12);
    return { name: "Current User", data };
  };

  test("an encrypted .pptx is an OLE file with the encryption streams, whatever its name", () => {
    const file = write("himno.pptx", compoundFile([stream("EncryptionInfo"), stream("EncryptedPackage", 4096)]));
    expect(containerKind(file)).toBe("binary");
    expect(sniffUnreadableDeck(file)).toBe("DECK_PASSWORD");
  });

  test("an encrypted PowerPoint 97 deck: an EncryptedSummary stream, or the encrypted header token", () => {
    const withSummary = compoundFile([stream("PowerPoint Document"), currentUser(0xe391c05f), stream("EncryptedSummary")]);
    expect(sniffUnreadableDeck(write("summary.ppt", withSummary))).toBe("DECK_PASSWORD");
    const flagged = compoundFile([stream("PowerPoint Document"), currentUser(0xf3d1c4df)]);
    expect(sniffUnreadableDeck(write("flagged.ppt", flagged))).toBe("DECK_PASSWORD");
  });

  test("PowerPoint 4 (a PP40 stream) and PowerPoint 95 (a short Current User) are an old format", () => {
    expect(sniffUnreadableDeck(write("pp40.ppt", compoundFile([stream("PP40", 4096)])))).toBe("DECK_OLD_FORMAT");
    // `compoundFile` pads every stream past the mini-stream cutoff; PowerPoint
    // 95's 15-byte `Current User` (stream 2) needs its true size, read from
    // regular sectors (cutoff 0).
    const pp95 = compoundFile([stream("PowerPoint Document", 4096), stream("Current User")]);
    pp95.writeUInt32LE(0, 56);
    pp95.writeUInt32LE(15, (pp95.readUInt32LE(48) + 1) * 512 + 2 * 128 + 120);
    expect(sniffUnreadableDeck(write("pp95.ppt", pp95))).toBe("DECK_OLD_FORMAT");
  });

  test("anything else is not a presentation — a 97 deck, a zip, random bytes, nothing at all", () => {
    expect(sniffUnreadableDeck(write("plain.ppt", buildLegacyPpt()))).toBe("NOT_A_PRESENTATION");
    expect(sniffUnreadableDeck(write("other.ppt", compoundFile([stream("WordDocument")])))).toBe("NOT_A_PRESENTATION");
    expect(sniffUnreadableDeck(write("broken.pptx", zipSync({ "x.txt": strToU8("x") })))).toBe("NOT_A_PRESENTATION");
    expect(sniffUnreadableDeck(write("noise.pps", Buffer.from("not a deck at all")))).toBe("NOT_A_PRESENTATION");
    expect(sniffUnreadableDeck(path.join(tmpDir, "missing.ppt"))).toBe("NOT_A_PRESENTATION");
  });
});
