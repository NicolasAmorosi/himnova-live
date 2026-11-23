import path from "node:path";
import { readZipEntries } from "../zip-reader";
import { parseXml, type XmlElement } from "./xml";

export type Relationship = { type: string; target: string; external: boolean };

/**
 * A `.pptx` opened for reading: every XML part and every relationship list,
 * read in one pass of the central directory (`readZipEntries`, which never
 * reads the archive whole). Pictures and media are NOT read here — a slide
 * names them by part and they are served by range from the original.
 */
export type PptxPackage = {
  file: string;
  xml(part: string): XmlElement | null;
  rels(part: string): Map<string, Relationship>;
  has(part: string): boolean;
  /** Every part name in the archive, XML or not. */
  parts: ReadonlySet<string>;
};

export function openPptx(file: string): PptxPackage {
  const allNames = new Set<string>();
  const raw = readZipEntries(file, (name) => {
    allNames.add(name);
    // `.vml`: the legacy drawing where old OLE objects keep their preview.
    return name.endsWith(".xml") || name.endsWith(".rels") || name.endsWith(".vml");
  });
  const parsed = new Map<string, XmlElement | null>();
  const relCache = new Map<string, Map<string, Relationship>>();

  const xml = (part: string): XmlElement | null => {
    if (!parsed.has(part)) {
      const bytes = raw[part];
      parsed.set(part, bytes ? parseXml(bytes) : null);
    }
    return parsed.get(part) ?? null;
  };

  const rels = (part: string): Map<string, Relationship> => {
    const cached = relCache.get(part);
    if (cached) return cached;
    const dir = path.posix.dirname(part);
    const relsPart = path.posix.join(dir, "_rels", `${path.posix.basename(part)}.rels`);
    const out = new Map<string, Relationship>();
    for (const r of xml(relsPart)?.children ?? []) {
      const id = r.attrs["Id"];
      const target = r.attrs["Target"];
      if (!id || target === undefined) continue;
      const external = r.attrs["TargetMode"] === "External";
      out.set(id, {
        type: (r.attrs["Type"] ?? "").split("/").pop() ?? "",
        target: external ? target : resolvePart(dir, target),
        external,
      });
    }
    relCache.set(part, out);
    return out;
  };

  return { file, xml, rels, has: (part) => allNames.has(part), parts: allNames };
}

/** A relationship target relative to the source part's folder; a leading `/`
 *  is relative to the package root. */
export function resolvePart(fromDir: string, target: string): string {
  const decoded = safeDecode(target);
  const joined = decoded.startsWith("/") ? decoded.slice(1) : path.posix.join(fromDir, decoded);
  return path.posix.normalize(joined).replace(/^\.\//, "");
}

/** A link with a stray `%`, or a Latin-1 escape such as `%F1` («ñ» the way old
 *  Office wrote it), is not valid UTF-8 percent-encoding and makes
 *  `decodeURIComponent` throw, which, uncaught on the deck's open path, made
 *  that presentation impossible to open again. The raw text is the better
 *  guess. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The first relationship of `type` from `part`, as a part name. */
export function relTarget(pkg: PptxPackage, part: string, type: string): string | null {
  for (const r of pkg.rels(part).values()) if (r.type === type && !r.external) return r.target;
  return null;
}
