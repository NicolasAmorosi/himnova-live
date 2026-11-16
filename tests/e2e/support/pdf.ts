/** A line of text on a page, centred (by an average Times width — close
 *  enough to look centred), `y` up from the bottom, in points. */
export type PdfText = { text: string; size: number; y: number; color: string; italic?: boolean };

/**
 * A PDF with one 16:9 page per colour. Without `texts`, each page has a white
 * square that moves one step to the right per page, so two slides never
 * rasterize alike; with them, a page carries its own lines instead, in the
 * standard Times faces — not embedded, so the rasterizer takes them from the
 * system (`.claude/knowledge/a-pdf-source-breaks-two-assumptions-the-pipeline-made-about-its-own-output.md`).
 * Text is written in WinAnsi, which covers Spanish.
 */
export function buildPdf(colors: readonly string[], texts?: readonly (readonly PdfText[])[]): Buffer {
  const width = 960;
  const height = 540;
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1;
  const rgb = (hex: string) => [1, 3, 5].map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(3)).join(" ");
  const literal = (text: string) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

  const catalog = add("");
  const pagesIndex = add("");
  const fonts = texts
    ? `/Font << /F1 ${add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>") + 1} 0 R ` +
      `/F2 ${add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>") + 1} 0 R >>`
    : "";
  const pageIds: number[] = [];
  colors.forEach((hex, i) => {
    const lines = texts?.[i];
    const marks = lines
      ? lines
          .map((line) => {
            const x = Math.max(24, (width - line.text.length * line.size * 0.45) / 2);
            return `BT ${rgb(line.color)} rg /${line.italic ? "F2" : "F1"} ${line.size} Tf ${x.toFixed(1)} ${line.y} Td ${literal(line.text)} Tj ET`;
          })
          .join(" ")
      : `1 1 1 rg ${120 + i * 240} 180 180 180 re f`;
    const stream = `${rgb(hex)} rg 0 0 ${width} ${height} re f ${marks}`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesIndex + 1} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${content + 1} 0 R /Resources << ${fonts} >> >>`,
      ),
    );
  });
  objects[catalog] = `<< /Type /Catalog /Pages ${pagesIndex + 1} 0 R >>`;
  objects[pagesIndex] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id + 1} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog + 1} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/**
 * A one-page PDF (16:9) that is a single image filling it: `dict` names its filter and what the filter needs, `data`
 * is the encoded stream. For the images pdf.js decodes with its own WebAssembly (JPEG 2000, CCITT, JBIG2): a scanned
 * page is exactly this.
 */
export function buildImagePdf(dict: string, data: Uint8Array): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : Buffer.from(chunk);
    parts.push(bytes);
    size += bytes.length;
  };
  const object = (...body: (string | Uint8Array)[]) => {
    offsets.push(size);
    push(`${offsets.length} 0 obj\n`);
    body.forEach(push);
    push("\nendobj\n");
  };
  const content = "q 960 0 0 540 0 0 cm /Im1 Do Q";
  push("%PDF-1.5\n");
  object("<< /Type /Catalog /Pages 2 0 R >>");
  object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>");
  object(`<< /Type /XObject /Subtype /Image ${dict} /Length ${data.length} >>\nstream\n`, data, "\nendstream");
  object(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = size;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  push(offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join(""));
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/**
 * A 64×64 scan whose left half is black, as CCITT Group 3 one-dimensional (`/K 0`): each row a white run of 0, a black
 * run of 32 and a white run of 32, in ITU-T T.4's codes. pdf.js decodes every CCITT image with the same WebAssembly.
 */
export function ccittHalfBlack(): { dict: string; data: Uint8Array } {
  const row = "00110101" + "000001101010" + "00011011";
  const bits = row.repeat(64);
  const data = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) if (bits[i] === "1") data[i >> 3]! |= 0x80 >> (i & 7);
  return {
    dict: "/Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K 0 /Columns 64 /Rows 64 >>",
    data,
  };
}
