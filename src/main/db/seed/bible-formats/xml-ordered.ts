import { XMLParser } from "fast-xml-parser";

/**
 * An ordered walk over an XML document, for the two formats that need one.
 *
 * Zefania can be read out of `fast-xml-parser`'s ordinary object model because
 * a Zefania verse IS an element: `<VERS vnumber="1">…</VERS>`. USFX and OSIS
 * are built the other way round — their verses are MILESTONES, empty elements
 * that mark where a verse begins, with the text of the verse sitting after
 * them as a SIBLING:
 *
 *   <v id="1"/>En el principio creó Dios…<ve/><v id="2"/>Y la tierra…
 *
 * In the object model, `{v: […], "#text": "En el principio… Y la tierra…"}` —
 * every verse of the chapter concatenated into one string, with nothing left
 * to say where one ended. The document order IS the data, so it has to be
 * preserved, which is what `preserveOrder: true` is for and why these two
 * formats get their own reader instead of a branch in the Zefania one.
 *
 * `trimValues: false` matters for the same reason: in a milestoned document
 * the whitespace BETWEEN two text runs is the space between two words. The
 * collector normalizes runs of whitespace once, at the end, where it is safe.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  textNodeName: "#text",
  trimValues: false,
  parseAttributeValue: false,
  // Text stays text: by default «2.50» came back as the number 2.5, a CCLI
  // number lost its leading zeros, and a compact OpenLyrics line «1.» read «1».
  parseTagValue: false,
  processEntities: true,
});

/** One node of `preserveOrder` output: a single tag key whose value is the
 *  child list, plus an optional `":@"` holding the attributes. A text node
 *  uses the key `#text` and a string value. */
type OrderedNode = Record<string, unknown>;

export type Visitor = {
  /** Return `false` to drop the element and everything under it — a footnote,
   *  a cross-reference, a section heading. `depth` is 0 for the document's own
   *  root element. */
  enter: (tag: string, attrs: Record<string, string>, depth: number) => boolean;
  exit: (tag: string, attrs: Record<string, string>, depth: number) => void;
  text: (value: string) => void;
};

function tagOf(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ":@") return key;
  }
  return null;
}

function attrsOf(node: OrderedNode): Record<string, string> {
  const raw = node[":@"] as Record<string, unknown> | undefined;
  if (!raw) return {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // `xml:lang` arrives as `@_xml:lang`; the prefix is dropped so a handler
    // can ask for "lang" without caring which namespace spelled it.
    attrs[key.replace(/^@_/, "").replace(/^xml:/, "")] = String(value);
  }
  return attrs;
}

function walkNodes(nodes: unknown[], visitor: Visitor, depth: number): void {
  for (const raw of nodes) {
    if (raw === null || typeof raw !== "object") continue;
    const node = raw as OrderedNode;
    const tag = tagOf(node);
    if (tag === null) continue;

    if (tag === "#text") {
      const value = node[tag];
      if (typeof value === "string") visitor.text(value);
      else if (typeof value === "number") visitor.text(String(value));
      continue;
    }

    const attrs = attrsOf(node);
    if (!visitor.enter(tag, attrs, depth)) continue;
    const children = node[tag];
    if (Array.isArray(children)) walkNodes(children, visitor, depth + 1);
    visitor.exit(tag, attrs, depth);
  }
}

/** Parses `xml` and walks it in document order. */
export function walkXml(xml: string, visitor: Visitor): void {
  walkNodes(parser.parse(xml) as unknown[], visitor, 0);
}

/** The leading integer of an id that may be a range (`"1"`, `"1-2"`, `"3a"`),
 *  or `null`. Ranges are common in both formats and are stored under their
 *  first number: a combined verse has to live somewhere, and "where the
 *  reference points" is the only answer the operator can use. */
export function leadingNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+)/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}
