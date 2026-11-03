import { readZipEntries } from "../zip-reader";
import { attr, child, children, path } from "../pptx/xml";
import { parseOdfXml, type XmlElement } from "./xml";

/**
 * An `.odp` opened for reading: `content.xml` and `styles.xml` parsed, read in
 * one pass of the central directory (`readZipEntries`, which never reads the
 * archive whole), plus the name of every entry. Pictures, media and fonts are
 * never read here — the model names them by entry and they are served from
 * the original.
 */
export type OdpPackage = {
  file: string;
  content: XmlElement;
  /** `null` when the file has none, or one that won't parse — drawn with the
   *  defaults, every slide counting `styles:unreadable`. */
  styles: XmlElement | null;
  stylesBroken: boolean;
  parts: ReadonlySet<string>;
  /** The `office:presentation` element: the pages. */
  presentation: XmlElement;
  sheet: StyleSheet;
  /** The document's default tab interval (`settings.xml`), EMU; `null` when it doesn't say. */
  defaultTab: number | null;
};

const PRESENTATION_TYPES = new Set([
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.presentation-template",
]);

/** Opens the package, or throws when it isn't an OpenDocument presentation. */
export function openOdp(file: string): OdpPackage {
  const parts = new Set<string>();
  const raw = readZipEntries(file, (name) => {
    parts.add(name);
    return name === "mimetype" || name === "content.xml" || name === "styles.xml" || name === "settings.xml";
  });
  const mimetype = raw["mimetype"] ? Buffer.from(raw["mimetype"]).toString("latin1").trim() : null;
  if (mimetype !== null && !PRESENTATION_TYPES.has(mimetype)) throw new Error(`not an OpenDocument presentation (${mimetype.slice(0, 80)})`);
  const contentBytes = raw["content.xml"];
  if (!contentBytes) throw new Error("not an OpenDocument presentation: no content.xml");
  const content = parseOdfXml(contentBytes, "content.xml");
  const presentation = path(content, "office:body", "office:presentation");
  if (content.name !== "office:document-content" || !presentation) throw new Error("not an OpenDocument presentation: no office:presentation");
  let styles: XmlElement | null = null;
  let stylesBroken = false;
  if (raw["styles.xml"]) {
    try {
      styles = parseOdfXml(raw["styles.xml"], "styles.xml");
    } catch {
      stylesBroken = true;
    }
  }
  // A single setting is wanted from settings.xml: read, not parsed.
  const settings = raw["settings.xml"] ? Buffer.from(raw["settings.xml"]).toString("utf8") : "";
  const tab = /config:name="DefaultTabStop"[^>]*>\s*(\d+)\s*</.exec(settings);
  const defaultTab = tab && Number(tab[1]) > 0 ? Number(tab[1]) * 360 : null;
  return { file, content, styles, stylesBroken, parts, presentation, sheet: new StyleSheet(content, styles), defaultTab };
}

/** Properties of one kind (`style:graphic-properties`, …), attributes merged
 *  from the least specific style up. */
export type Props = Record<string, string>;

/** A style with its whole inheritance resolved. Elements that aren't
 *  attributes (a list style, tab stops) come from the most specific style
 *  that has them. */
export type Resolved = {
  graphic: Props;
  paragraph: Props;
  text: Props;
  page: Props;
  cell: Props;
  column: Props;
  row: Props;
  listStyle: XmlElement | null;
  tabStops: XmlElement | null;
  columns: XmlElement | null;
  sound: XmlElement | null;
};

export const EMPTY: Resolved = Object.freeze({
  graphic: {}, paragraph: {}, text: {}, page: {}, cell: {}, column: {}, row: {},
  listStyle: null, tabStops: null, columns: null, sound: null,
});

/** Where a name is looked up: content.xml's automatic styles or styles.xml's
 *  (the master pages'), then the common styles either way. */
export type Scope = "content" | "styles";

const KINDS: [keyof Resolved & ("graphic" | "paragraph" | "text" | "page" | "cell" | "column" | "row"), string][] = [
  ["graphic", "style:graphic-properties"],
  ["paragraph", "style:paragraph-properties"],
  ["text", "style:text-properties"],
  ["page", "style:drawing-page-properties"],
  ["cell", "style:table-cell-properties"],
  ["column", "style:table-column-properties"],
  ["row", "style:table-row-properties"],
];

/** Font sizes may be a percentage of the size they inherit. */
const SIZE_ATTRS = new Set(["fo:font-size", "style:font-size-asian", "style:font-size-complex"]);

/** `source` over `target`, resolving a percentage font size against the size
 *  it overrides. */
export function mergeProps(target: Props, source: Props): void {
  for (const [key, value] of Object.entries(source)) {
    if (SIZE_ATTRS.has(key) && value.endsWith("%")) {
      const base = target[key];
      const pct = parseFloat(value);
      if (base && base.endsWith("pt") && Number.isFinite(pct)) {
        target[key] = `${(parseFloat(base) * pct) / 100}pt`;
        continue;
      }
    }
    target[key] = value;
  }
}

export class StyleSheet {
  /** `family/name` → style element, per scope; common styles in both. */
  private readonly byScope: Record<Scope, Map<string, XmlElement>> = { content: new Map(), styles: new Map() };
  private readonly common = new Map<string, XmlElement>();
  private readonly defaults = new Map<string, XmlElement>();
  /** `draw:gradient`, `draw:hatch`, `draw:fill-image`, `draw:marker`,
   *  `draw:stroke-dash`, `draw:opacity` by `draw:name`. */
  private readonly drawing = new Map<string, XmlElement>();
  private readonly cache = new Map<string, Resolved>();
  readonly masters = new Map<string, XmlElement>();
  readonly masterList: XmlElement[] = [];
  readonly pageLayouts = new Map<string, XmlElement>();
  readonly fontFaces = new Map<string, XmlElement>();
  readonly tableTemplates = new Map<string, XmlElement>();

  constructor(content: XmlElement, styles: XmlElement | null) {
    for (const doc of [styles, content]) {
      for (const face of children(child(doc, "office:font-face-decls"), "style:font-face")) {
        const name = attr(face, "style:name");
        if (name && !this.fontFaces.has(name)) this.fontFaces.set(name, face);
      }
    }
    for (const doc of [styles, content]) {
      for (const el of child(doc, "office:styles")?.children ?? []) {
        if (el.name === "style:default-style") {
          this.defaults.set(attr(el, "style:family") ?? "", el);
          continue;
        }
        if (el.name === "table:table-template") {
          const name = attr(el, "text:style-name") ?? attr(el, "table:name") ?? attr(el, "style:name");
          if (name) this.tableTemplates.set(name, el);
          continue;
        }
        const drawName = attr(el, "draw:name");
        if (drawName && el.name.startsWith("draw:")) this.drawing.set(`${el.name}/${drawName}`, el);
        const key = styleKey(el);
        if (key) this.common.set(key, el);
      }
    }
    const index = (doc: XmlElement | null, scope: Scope): void => {
      for (const el of child(doc, "office:automatic-styles")?.children ?? []) {
        if (el.name === "style:page-layout") {
          const name = attr(el, "style:name");
          if (name) this.pageLayouts.set(name, el);
          continue;
        }
        const key = styleKey(el);
        if (key) this.byScope[scope].set(key, el);
      }
    };
    index(content, "content");
    index(styles, "styles");
    for (const master of children(child(styles, "office:master-styles"), "style:master-page")) {
      const name = attr(master, "style:name");
      if (!name) continue;
      this.masters.set(name, master);
      this.masterList.push(master);
    }
  }

  /** A named `draw:` definition from the common styles. */
  definition(kind: "draw:gradient" | "draw:hatch" | "draw:fill-image" | "draw:marker" | "draw:stroke-dash" | "draw:opacity", name: string | null | undefined): XmlElement | null {
    return name ? (this.drawing.get(`${kind}/${name}`) ?? null) : null;
  }

  find(scope: Scope, family: string, name: string | null | undefined): XmlElement | null {
    if (!name) return null;
    const key = `${family}/${name}`;
    return this.byScope[scope].get(key) ?? this.common.get(key) ?? null;
  }

  /** A style with its parents and its family's default style folded in. */
  resolve(scope: Scope, family: string, name: string | null | undefined): Resolved {
    if (!name) return this.defaultsOf(family);
    const cacheKey = `${scope}|${family}|${name}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const chain: XmlElement[] = [];
    let at = this.find(scope, family, name);
    // Presentation and graphic styles are each other's kin: a writer that
    // names one where the other belongs still means that style.
    if (!at && (family === "presentation" || family === "graphic")) at = this.find(scope, family === "graphic" ? "presentation" : "graphic", name);
    const seen = new Set<XmlElement>();
    while (at && !seen.has(at) && chain.length < 32) {
      seen.add(at);
      chain.unshift(at);
      const parent = attr(at, "style:parent-style-name");
      at = parent ? (this.common.get(`${attr(at, "style:family") ?? family}/${parent}`) ?? null) : null;
    }
    const out = this.fold([this.defaults.get(defaultFamily(family)) ?? null, ...chain], scope);
    this.cache.set(cacheKey, out);
    return out;
  }

  private defaultsOf(family: string): Resolved {
    const key = `|${family}|`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const out = this.fold([this.defaults.get(defaultFamily(family)) ?? null], "content");
    this.cache.set(key, out);
    return out;
  }

  private fold(chain: (XmlElement | null)[], scope: Scope): Resolved {
    const out: Resolved = { graphic: {}, paragraph: {}, text: {}, page: {}, cell: {}, column: {}, row: {}, listStyle: null, tabStops: null, columns: null, sound: null };
    for (const el of chain) {
      if (!el) continue;
      for (const [kind, name] of KINDS) {
        const props = child(el, name);
        if (props) mergeProps(out[kind], props.attrs);
      }
      const graphic = child(el, "style:graphic-properties");
      const listStyle = child(graphic, "text:list-style") ?? this.find(scope, "list", attr(el, "style:list-style-name"));
      if (listStyle) out.listStyle = listStyle;
      const tabs = child(child(el, "style:paragraph-properties"), "style:tab-stops");
      if (tabs) out.tabStops = tabs;
      const columns = child(graphic, "style:columns");
      if (columns) out.columns = columns;
      const sound = child(child(el, "style:drawing-page-properties"), "presentation:sound");
      if (sound) out.sound = sound;
    }
    return out;
  }

  /** The face a `style:font-name` names, as its first family. */
  fontFamily(name: string | null | undefined): string | null {
    if (!name) return null;
    const face = this.fontFaces.get(name);
    return firstFamily(attr(face, "svg:font-family")) ?? (face ? name : null);
  }
}

function styleKey(el: XmlElement): string | null {
  const name = attr(el, "style:name");
  if (!name) return null;
  if (el.name === "style:style") return `${attr(el, "style:family") ?? ""}/${name}`;
  if (el.name === "text:list-style") return `list/${name}`;
  return null;
}

/** Presentation styles have no default of their own: the graphic one is
 *  theirs, as in Impress. */
function defaultFamily(family: string): string {
  return family === "presentation" ? "graphic" : family;
}

/** `'DejaVu Sans', sans-serif` → `DejaVu Sans`. */
export function firstFamily(list: string | null | undefined): string | null {
  if (!list) return null;
  const first = list.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "").trim();
  return first || null;
}
