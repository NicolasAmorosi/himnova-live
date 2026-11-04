import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { XmlElement } from "../pptx/xml";

export type { XmlElement };

/**
 * ODF XML, read the way the `.pptx` reader reads OOXML (`../pptx/xml.ts`) —
 * names carry the CANONICAL prefix of their namespace whatever the file bound
 * it to — with one difference that matters for text: ODF text is MIXED
 * content (`<text:p>Hello <text:span>world</text:span> again</text:p>`), so
 * text nodes stay in `children`, in order, as elements named `#text`.
 */
export const TEXT_NODE = "#text";

const CANONICAL: Record<string, string> = {
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0": "office",
  "urn:oasis:names:tc:opendocument:xmlns:style:1.0": "style",
  "urn:oasis:names:tc:opendocument:xmlns:text:1.0": "text",
  "urn:oasis:names:tc:opendocument:xmlns:table:1.0": "table",
  "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": "draw",
  "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0": "fo",
  "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0": "svg",
  "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0": "presentation",
  "urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0": "smil",
  "urn:oasis:names:tc:opendocument:xmlns:animation:1.0": "anim",
  "urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0": "dr3d",
  "urn:oasis:names:tc:opendocument:xmlns:chart:1.0": "chart",
  "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0": "number",
  "urn:oasis:names:tc:opendocument:xmlns:meta:1.0": "meta",
  "urn:oasis:names:tc:opendocument:xmlns:form:1.0": "form",
  "urn:oasis:names:tc:opendocument:xmlns:script:1.0": "script",
  "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0": "manifest",
  "urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0": "loext",
  "http://openoffice.org/2004/office": "ooo",
  "http://openoffice.org/2009/office": "officeooo",
  "http://openoffice.org/2010/draw": "drawooo",
  "http://www.w3.org/1999/xlink": "xlink",
  "http://www.w3.org/XML/1998/namespace": "xml",
};

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  // Also decodes numeric character references (`&#233;`), which the XML-only
  // entity table leaves as they are.
  htmlEntities: true,
});

type Raw = Record<string, unknown>;

/**
 * One part of the package, parsed. Throws on XML that isn't well-formed: the
 * parser itself never does — it returns whatever it made of the broken
 * markup — and a `content.xml` read half is a deck drawn wrong in silence.
 */
export function parseOdfXml(bytes: Uint8Array, part: string): XmlElement {
  let source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const valid = XMLValidator.validate(source);
  if (valid !== true) throw new Error(`${part} is not well-formed XML (line ${valid.err.line}: ${valid.err.msg})`);
  const raw = parser.parse(source) as Raw[];
  const root = raw.find((node) => !(TEXT_NODE in node) && !Object.keys(node)[0]!.startsWith("?"));
  if (!root) throw new Error(`${part} has no root element`);
  return convert(root, new Map());
}

function convert(node: Raw, inherited: Map<string, string>): XmlElement {
  const rawName = Object.keys(node).find((key) => key !== ":@")!;
  const rawAttrs = (node[":@"] ?? {}) as Record<string, string>;
  let scope = inherited;
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) {
      if (scope === inherited) scope = new Map(inherited);
      scope.set(key === "xmlns" ? "" : key.slice(6), value);
    }
  }
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) continue;
    attrs[key.includes(":") ? canonicalName(key, scope) : key] = String(value);
  }
  const children: XmlElement[] = [];
  let text = "";
  for (const c of (node[rawName] ?? []) as Raw[]) {
    if (TEXT_NODE in c) {
      const value = String(c[TEXT_NODE]);
      text += value;
      children.push({ name: TEXT_NODE, attrs: {}, children: [], text: value });
    } else if (Object.keys(c)[0]?.startsWith("?") !== true) children.push(convert(c, scope));
  }
  return { name: canonicalName(rawName, scope), attrs, children, text };
}

function canonicalName(name: string, scope: Map<string, string>): string {
  const colon = name.indexOf(":");
  const prefix = colon < 0 ? "" : name.slice(0, colon);
  const uri = scope.get(prefix);
  const canonical = uri === undefined ? undefined : CANONICAL[uri];
  return canonical !== undefined ? `${canonical}:${colon < 0 ? name : name.slice(colon + 1)}` : name;
}

/** Every text node under `el`, in order — what a reader sees, minus markup. */
export function textOf(el: XmlElement | null | undefined): string {
  if (!el) return "";
  if (el.name === TEXT_NODE) return el.text;
  return el.children.map(textOf).join("");
}
