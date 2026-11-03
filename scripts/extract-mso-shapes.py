"""LibreOffice's built-in MS Office shape table (svx EnhancedCustomShapeGeometry.cxx, MPL-2.0)
as JSON: one entry per MSO_SPT number. Usage: extract-mso-shapes.py <geometry.cxx> <msdffdef.hxx> <out.json>"""
import json, re, sys

geo_path, def_path, out_path = sys.argv[1:4]
geo = open(geo_path, encoding="utf-8").read()
defs = open(def_path, encoding="utf-8").read()

# Symbols: DFF_Prop_* numbers, MSO_SPT names, handle flags.
sym = {}
for m in re.finditer(r"#define\s+(DFF_Prop_\w+)\s+(\d+)", defs):
    sym[m.group(1)] = int(m.group(2))
spt = {}
for m in re.finditer(r"^\s*(mso_spt\w+)\s*=\s*(\w+)\s*,", defs, re.M):
    v = m.group(2)
    spt[m.group(1)] = int(v, 0) if re.match(r"^(0x)?[0-9a-fA-F]+$", v) else spt.get(v, 0)
sym["MIN_INT32"] = -(2 ** 31)
HF = {"NONE": 0, "MIRRORED_X": 1, "MIRRORED_Y": 2, "SWITCHED": 4, "POLAR": 8, "MAP": 0x10, "RANGE": 0x20,
      "RANGE_X_MIN_IS_SPECIAL": 0x80, "RANGE_X_MAX_IS_SPECIAL": 0x100, "RANGE_Y_MIN_IS_SPECIAL": 0x200,
      "RANGE_Y_MAX_IS_SPECIAL": 0x400, "CENTER_X_IS_SPECIAL": 0x800, "CENTER_Y_IS_SPECIAL": 0x1000, "RADIUS_RANGE": 0x2000}


def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)


src = strip_comments(geo)


def value(tok):
    """A number, a symbol, or `n MSO_I` (a reference to formula n) → int, or "@n" for a reference."""
    tok = tok.strip()
    if not tok:
        return None
    tok = re.sub(r"\b(\d+|0x[0-9a-fA-F]+)[uUlL]+\b", r"\1", tok)
    m = re.fullmatch(r"(\w+)\s+MSO_I", tok)
    if m:
        return "@%d" % int(m.group(1), 0)
    expr = re.sub(r"SvxMSDffHandleFlags::(\w+)", lambda mm: str(HF[mm.group(1)]), tok)
    expr = re.sub(r"[A-Za-z_]\w*", lambda mm: str(sym[mm.group(0)]) if mm.group(0) in sym else mm.group(0), expr)
    expr = re.sub(r"static_cast<\w+>", "int", expr).replace("M_SQRT2", "1.4142135623730951")
    return int(eval(expr, {"__builtins__": {}, "int": int}))  # noqa: S307 — our own trusted source file


def array(name):
    m = re.search(r"const\s+[\w:]+\s+" + re.escape(name) + r"\s*\[\s*\]\s*=\s*\{(.*?)\};", src, re.S)
    if not m:
        raise KeyError(name)
    return m.group(1)


def flat(body):
    """Every scalar in an initializer, braces dropped, in order."""
    body = body.replace("{", " ").replace("}", " ")
    return [value(t) for t in body.split(",") if t.strip()]


def span(arg):
    m = re.search(r"std::span<[^>]*>\(\s*(\w*)\s*\)", arg)
    return m.group(1) if m and m.group(1) else None


shapes = {}
for m in re.finditer(r"const\s+mso_CustomShape\s+(\w+)\s*=\s*\{(.*?)\};", src, re.S):
    name, body = m.group(1), m.group(2)
    parts = re.findall(r"std::span<[^>]*>\(\s*\w*\s*\)|[^,]+", body)
    parts = [p.strip() for p in parts if p.strip()]
    verts, segs, calc, dflt, text = (span(parts[i]) for i in range(5))
    w, h, xr, yr = (value(p) for p in parts[5:9])
    handles = span(parts[10]) if len(parts) > 10 else None
    entry = {"w": w, "h": h}
    if xr != -(2 ** 31): entry["xr"] = xr
    if yr != -(2 ** 31): entry["yr"] = yr
    if verts:
        v = flat(array(verts)); entry["v"] = [v[i:i + 2] for i in range(0, len(v), 2)]
    if segs: entry["s"] = flat(array(segs))
    if calc:
        c = flat(array(calc)); entry["c"] = [c[i:i + 4] for i in range(0, len(c), 4)]
    if dflt:
        d = flat(array(dflt)); entry["d"] = d[1:1 + d[0]]
    if text:
        t = flat(array(text)); entry["t"] = [t[i:i + 4] for i in range(0, len(t), 4)]
    if handles:
        hs = flat(array(handles))
        angles = []
        for i in range(0, len(hs), 9):
            flags, px, py = hs[i], hs[i + 1], hs[i + 2]
            # LibreOffice's rule (msdffimp.cxx): a polar handle whose y names an adjust value or an
            # equation carries an angle, stored by Office as 16.16 fixed-point degrees.
            if isinstance(py, int) and flags & 8 and (py >= 0x256 or py <= 0x107):
                angles.append(i // 9)
        if angles: entry["a"] = angles
    shapes[name] = entry

table = {}
switch = re.search(r"GetCustomShapeContent\s*\(\s*MSO_SPT\s+\w+\s*\)\s*\{(.*?)return", src, re.S).group(1)
pending = []
for line in switch.splitlines():
    for case in re.findall(r"case\s+(mso_spt\w+)\s*:", line):
        pending.append(case)
    m = re.search(r"pCustomShape\s*=\s*&(\w+)", line)
    if m:
        for case in pending:
            table[spt[case]] = m.group(1)
        pending = []


def bits(name):
    vals = flat(array(name))
    return [i for i in range(len(vals) * 16) if vals[i >> 4] & (1 << (i & 15))]


out = {
    "source": "LibreOffice svx/source/customshapes/EnhancedCustomShapeGeometry.cxx (MPL-2.0)",
    "shapes": {str(k): shapes[v] for k, v in sorted(table.items())},
    "notFilled": bits("mso_DefaultFillingTable"),
    "notStroked": bits("mso_DefaultStrokingTable"),
}
json.dump(out, open(out_path, "w"), separators=(",", ":"))
print(len(out["shapes"]), "shapes;", "not filled:", out["notFilled"][:40], "not stroked:", out["notStroked"])
