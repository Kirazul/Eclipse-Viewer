#!/usr/bin/env python3
"""
lines_map.py - which retail display each row of the two local item lines wears.

    python bake/tools/lines_map.py            # writes bake/data/lines.json.gz, prints coverage
    python bake/tools/lines_map.py --report   # coverage only, nothing written

The client's and the realm's tables can only be read on the owner's PC, and the
cloud bake has no copy of them. So this runs here, once, and commits a small text
file of ids and names, no art: the cloud then bakes both lines from Blizzard's CDN.

    client    the 3.3.5 client's own Item.dbc, as Eclipse's "This client" source reads it
    eclipse   the realm's appearance catalogue (catalogue.ecap), item rows only

A row becomes a retail ItemDisplayInfo by the first route that answers, and keeps
the route it took:

    item+files   retail has this item id, and its display names the row's files
    files        the row's model and texture file names find a retail display
    item         retail has this item id, its art has since been updated
    texture      the row's texture alone finds one (no model to check, or a renamed one)

Anything else is left out and counted. No pixel matching: a row retail does not have
under any of these is not chased.

Also records what the DLL accepts, so ItemEntry.entry can be trusted: the Midnight and
War Within displays its two line catalogues hold, and the local display id of every
retail mount display.

Inputs, all read only, none of them leave this PC except as the ids in the output:
    ECLIPSE_REPO (default ../Eclipse1): re/out/dbc/{live,realm}, Eclipse/data/appearances,
    Eclipse/packs/{midnight,warwithin,retailmounts}, src/eclipse/generated/item_names.bin,
    re/out/hearth/listfile.csv and the DB2 cache of the pinned build.
"""
from __future__ import annotations

import argparse
import collections
import csv
import gzip
import json
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, "bake", "data", "lines.json.gz")
ECLIPSE = os.environ.get("ECLIPSE_REPO") or os.path.join(os.path.dirname(REPO), "Eclipse1")
BUILD = "12.1.0.69933"
DB2 = os.path.join(ECLIPSE, "re", "out", "races", "db2-" + BUILD)

# Eclipse's dress::kHome: what can be worn at all, by InventoryType.
WEARABLE = {1, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25, 26}
ROUTES = ["item+files", "files", "item", "texture"]
# 3.3.5 ItemDisplayInfo.dbc, columns
IDI_MODEL = (1, 2)
IDI_TEX = (3, 4)
IDI_ICON = 5
IDI_BODY = tuple(range(15, 23))
# ...and the same eight regions as retail's ComponentSection order.
REGION_SUFFIX = ("_au", "_al", "_ha", "_tu", "_tl", "_lu", "_ll", "_fo")


def table(name, keep=None):
    with open(os.path.join(DB2, name + ".csv"), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            yield r if keep is None else {k: r.get(k, "") for k in keep}


class Dbc:
    """A WDBC file: every field an int, strings by offset."""

    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        magic, self.records, self.fields, self.recsize, self.strsize = struct.unpack_from("<4sIIII", self.data, 0)
        if magic != b"WDBC":
            raise SystemExit("not a WDBC: " + path)
        self.base = 20
        self.strings = 20 + self.records * self.recsize

    def rows(self):
        n = self.recsize // 4
        for i in range(self.records):
            yield struct.unpack_from("<%dI" % n, self.data, self.base + i * self.recsize)

    def text(self, off):
        if not off or off >= self.strsize:
            return ""
        start = self.strings + off
        end = self.data.index(b"\0", start)
        return self.data[start:end].decode("utf-8", "replace")


def stem(name):
    name = name.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name.rsplit(".", 1)[0] if "." in name else name


def read_listfile():
    """Basename -> fdids, for what lives under item/ only: the rest cannot match a row."""
    models, textures = collections.defaultdict(list), collections.defaultdict(list)
    path = os.path.join(ECLIPSE, "re", "out", "hearth", "listfile.csv")
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            fdid, _, p = line.rstrip("\n").partition(";")
            p = p.lower()
            if not p.startswith("item/"):
                continue
            if p.endswith(".m2"):
                models[stem(p)].append(int(fdid))
            elif p.endswith(".blp"):
                textures[stem(p)].append(int(fdid))
    return models, textures


class Retail:
    def __init__(self):
        t0 = time.time()
        self.ima_by_item = collections.defaultdict(list)
        for r in table("ItemModifiedAppearance", ("ID", "ItemID", "ItemAppearanceModifierID", "ItemAppearanceID", "OrderIndex")):
            self.ima_by_item[int(r["ItemID"])].append((int(r["OrderIndex"] or 0), int(r["ItemAppearanceModifierID"] or 0), int(r["ItemAppearanceID"])))
        self.appearance = {}
        self.appearance_of_display = {}
        for r in table("ItemAppearance", ("ID", "DisplayType", "ItemDisplayInfoID", "DefaultIconFileDataID")):
            a = (int(r["ItemDisplayInfoID"] or 0), int(r["DisplayType"] or 0), int(r["DefaultIconFileDataID"] or 0))
            self.appearance[int(r["ID"])] = a
            if a[0]:
                self.appearance_of_display.setdefault(a[0], int(r["ID"]))
        self.res_of_file = collections.defaultdict(set)
        self.files_of_res = collections.defaultdict(list)
        for r in table("ModelFileData", ("FileDataID", "ModelResourcesID")):
            f, res = int(r["FileDataID"]), int(r["ModelResourcesID"])
            self.res_of_file[f].add(res)
            self.files_of_res[res].append(f)
        self.mat_of_file = collections.defaultdict(set)
        self.files_of_mat = collections.defaultdict(list)
        for r in table("TextureFileData", ("FileDataID", "MaterialResourcesID")):
            f, mat = int(r["FileDataID"]), int(r["MaterialResourcesID"])
            self.mat_of_file[f].add(mat)
            self.files_of_mat[mat].append(f)
        self.display = {}
        self.by_model_res = collections.defaultdict(set)
        self.by_model_mat = collections.defaultdict(set)
        for r in table("ItemDisplayInfo", ("ID", "ModelResourcesID_0", "ModelResourcesID_1", "ModelMaterialResourcesID_0", "ModelMaterialResourcesID_1", "Flags")):
            d = int(r["ID"])
            res = [int(r["ModelResourcesID_%d" % k] or 0) for k in (0, 1)]
            mat = [int(r["ModelMaterialResourcesID_%d" % k] or 0) for k in (0, 1)]
            self.display[d] = (res, mat)
            for x in res:
                if x:
                    self.by_model_res[x].add(d)
            for x in mat:
                if x:
                    self.by_model_mat[x].add(d)
        self.sections = collections.defaultdict(list)
        self.by_section_mat = collections.defaultdict(set)
        for r in table("ItemDisplayInfoMaterialRes", ("ItemDisplayInfoID", "ComponentSection", "MaterialResourcesID")):
            d, s, m = int(r["ItemDisplayInfoID"]), int(r["ComponentSection"]), int(r["MaterialResourcesID"])
            self.sections[d].append((s, m))
            self.by_section_mat[m].add(d)
        self.extra_mats = collections.defaultdict(list)
        for r in table("ItemDisplayInfoModelMatRes", ("ItemDisplayInfoID", "MaterialResourcesID")):
            self.extra_mats[int(r["ItemDisplayInfoID"])].append(int(r["MaterialResourcesID"]))
        self.names = {}
        self.line_of_item = {}
        for r in table("ItemSparse", ("ID", "Display_lang", "ExpansionID")):
            self.names[int(r["ID"])] = r["Display_lang"]
            self.line_of_item[int(r["ID"])] = int(r["ExpansionID"] or 0)
        print("retail tables read in %.1f s" % (time.time() - t0), file=sys.stderr)

    def display_of_item(self, item):
        """The appearance an item shows unmodified: retail's first by order."""
        for _o, _m, app in sorted(self.ima_by_item.get(item, ())):
            a = self.appearance.get(app)
            if a and a[0]:
                return a[0]
        return 0

    def files_of_display(self, d, memo={}):
        """Every model and texture file a display names."""
        hit = memo.get(d)
        if hit is not None:
            return hit
        res, mat = self.display.get(d, ([], []))
        models, textures = set(), set()
        for x in res:
            models.update(self.files_of_res.get(x, ()))
        for x in mat:
            textures.update(self.files_of_mat.get(x, ()))
        for _s, m in self.sections.get(d, ()):
            textures.update(self.files_of_mat.get(m, ()))
        for m in self.extra_mats.get(d, ()):
            textures.update(self.files_of_mat.get(m, ()))
        memo[d] = (models, textures)
        return memo[d]


class Files:
    """The file names one row names, turned into retail fdids."""

    def __init__(self, listfile):
        self.models, self.textures = listfile

    def model_fdids(self, name):
        s = stem(name)
        if not s:
            return ()
        hit = self.models.get(s)
        if hit:
            return hit
        # A helm's name carries no race: retail's files are <stem>_<race><sex>.
        out = []
        for suffix in ("_hum_m", "_hum_f", "_hu_m", "_hu_f", "_hm", "_hf"):
            out += self.models.get(s + suffix, [])
        return out

    def texture_fdids(self, name, region=-1):
        s = stem(name)
        if not s:
            return ()
        # The realm named some of retail's textures after their own file id.
        tail = s.rsplit("_", 1)[-1]
        if tail.isdigit() and 6 <= len(tail) <= 8:
            return [int(tail)]
        if region < 0:
            return self.textures.get(s) or ()
        out = []
        # The 3.3.5 table names a body texture without its sex.
        for suffix in ("_u", "_m", "_f", ""):
            out += self.textures.get(s + suffix, [])
        return out


def resolve_rows(rows, retail, files):
    """rows: dicts with entry, slot name data. Adds .display and .route, or .why."""
    routes = collections.Counter()
    unresolved = []
    for row in rows:
        entry = row["entry"]
        names_models = [n for n in row["models"] if n]
        names_tex = [n for n in row["tex"] if n]
        names_body = [(i, n) for i, n in enumerate(row["body"]) if n]
        model_ids = {f for n in names_models for f in files.model_fdids(n)}
        tex_ids = {f for n in names_tex for f in files.texture_fdids(n)}
        body_ids = {f for i, n in names_body for f in files.texture_fdids(n, i)}
        want_tex = tex_ids | body_ids

        by_item = retail.display_of_item(entry) if row.get("retail_item", True) else 0
        verified = False
        if by_item:
            m, t = retail.files_of_display(by_item)
            verified = bool((model_ids & m) or (want_tex & t))
        if by_item and verified:
            row["display"], row["route"] = by_item, 0
            routes[0] += 1
            continue

        # Files: candidates that hold this model, narrowed by the textures.
        by_model = set()
        for f in model_ids:
            for res in retail.res_of_file.get(f, ()):
                by_model |= retail.by_model_res.get(res, set())
        by_tex = set()
        for f in tex_ids:
            for mat in retail.mat_of_file.get(f, ()):
                by_tex |= retail.by_model_mat.get(mat, set())
        by_body = collections.Counter()
        for f in body_ids:
            for mat in retail.mat_of_file.get(f, ()):
                for d in retail.by_section_mat.get(mat, ()):
                    by_body[d] += 1
        pick = 0
        if by_model and by_tex and (by_model & by_tex):
            pool = by_model & by_tex
            if by_body:
                pool = {d for d in pool if d in by_body} or pool
            pick = min(pool, key=lambda d: (d not in retail.appearance_of_display, -by_body.get(d, 0), d))
        elif not names_models and not names_tex and by_body:
            top = max(by_body.values())
            # Every region named must be found: half a chest is another chest.
            if top >= max(1, len(names_body)):
                pool = {d for d, n in by_body.items() if n == top}
                pick = min(pool, key=lambda d: (d not in retail.appearance_of_display, d))
        if pick:
            row["display"], row["route"] = pick, 1
            routes[1] += 1
            continue
        if by_item:
            row["display"], row["route"] = by_item, 2
            routes[2] += 1
            continue
        if by_tex:
            pick = min(by_tex, key=lambda d: (d not in retail.appearance_of_display, d))
            row["display"], row["route"] = pick, 3
            routes[3] += 1
            continue
        why = []
        why.append("no item %d in retail" % entry)
        if names_models and not model_ids:
            why.append("model %s not in the listfile" % names_models[0])
        elif model_ids and not by_model:
            why.append("model file known, in no display")
        if names_tex and not tex_ids:
            why.append("texture %s not in the listfile" % names_tex[0])
        elif tex_ids and not by_tex:
            why.append("texture file known, in no display")
        elif by_model and by_tex:
            why.append("model and texture never share a display")
        if not names_models and not names_tex:
            if names_body and not body_ids:
                why.append("body texture %s not in the listfile" % names_body[0][1])
            elif not names_body:
                why.append("row names no file at all")
            else:
                why.append("%d of %d regions found" % (max(by_body.values(), default=0), len(names_body)))
        row["why"] = "; ".join(why)
        unresolved.append(row)
    return routes, unresolved


def read_display_names(path):
    t = Dbc(path)
    out = {}
    for r in t.rows():
        out[r[0]] = {
            "models": [t.text(r[i]) for i in IDI_MODEL],
            "tex": [t.text(r[i]) for i in IDI_TEX],
            "icon": t.text(r[IDI_ICON]),
            "body": [t.text(r[i]) for i in IDI_BODY],
        }
    return out


def client_rows():
    base = os.path.join(ECLIPSE, "re", "out", "dbc", "live")
    names = read_display_names(os.path.join(base, "ItemDisplayInfo.dbc"))
    rows = []
    for r in Dbc(os.path.join(base, "Item.dbc")).rows():
        item, cls, sub, display, inv = r[0], r[1], r[2], r[5], r[6]
        if inv not in WEARABLE or not display or cls not in (2, 4):
            continue
        n = names.get(display)
        if not n:
            continue
        rows.append({"entry": item, "inv": inv, "cls": cls, "sub": sub, "src": display, **n})
    return rows


def read_item_names():
    """The realm's names, Eclipse's ENDC container: LZ4, then varint deltas."""
    sys.path.insert(0, os.path.join(ECLIPSE, "tools", "art"))
    sys.path.insert(0, os.path.join(ECLIPSE, "tools"))
    import item_names_embed as E  # noqa: E402

    with open(os.path.join(ECLIPSE, "src", "eclipse", "generated", "item_names.bin"), "rb") as f:
        return E.decode(f.read())


def realm_rows():
    """The item rows of catalogue.ecap. Its other rows are not items, and are counted."""
    with open(os.path.join(ECLIPSE, "Eclipse", "data", "appearances", "catalogue.ecap"), "rb") as f:
        d = f.read()
    _m, _v, nc, na, ns, nf, _nb = struct.unpack_from("<4sIIIIII", d, 0)
    head = 28
    apps = head + nc * 24
    sets_at = apps + na * 40
    flat_at = sets_at + ns * 16
    blob = d[flat_at + nf * 4:]

    def s(off):
        return blob[off:blob.index(b"\0", off)].decode("utf-8", "replace") if off else ""

    base = os.path.join(ECLIPSE, "re", "out", "dbc", "realm")
    items = {}
    for r in Dbc(os.path.join(base, "Item.dbc")).rows():
        items[r[0]] = (r[1], r[2], r[5], r[6])
    names = read_display_names(os.path.join(base, "ItemDisplayInfo.dbc"))
    kinds = collections.Counter()
    rows, by_app = [], {}
    for i in range(na):
        r = struct.unpack_from("<IIIIIIIHHHBBBBH", d, apps + i * 40)
        aid, _entry, did, kind, cls, sub, inv = r[0], r[1], r[2], r[10], r[11], r[12], r[13]
        kinds[kind] += 1
        if kind != 0:
            continue
        it = items.get(did)
        n = names.get(it[2]) if it else None
        row = {"entry": did, "aid": aid, "inv": inv, "cls": cls, "sub": sub, "src": it[2] if it else 0,
               "models": n["models"] if n else [s(r[5])], "tex": n["tex"] if n else [s(r[6])],
               "icon": n["icon"] if n else s(r[4]), "body": n["body"] if n else []}
        rows.append(row)
        by_app[aid] = did
    # A set row of the catalogue names an ItemSet; the set's items are that row's.
    t = Dbc(os.path.join(base, "ItemSet.dbc"))
    item_set = {r[0]: (t.text(r[1]), [v for v in r[18:35] if v]) for r in t.rows()}
    sets = []
    for i in range(na):
        r = struct.unpack_from("<IIIIIIIHHHBBBBH", d, apps + i * 40)
        if r[10] == 2 and r[2] in item_set:
            name, items = item_set[r[2]]
            if items:
                sets.append((r[2], name, items))
    return rows, sets, kinds


def client_sets():
    t = Dbc(os.path.join(ECLIPSE, "re", "out", "dbc", "live", "ItemSet.dbc"))
    out = []
    for r in t.rows():
        items = [v for v in r[18:35] if v]
        if items:
            out.append((r[0], t.text(r[1]), items))
    return out


def ecap_displays(line):
    """What the DLL's own line catalogue offers: entry = KEY | display, item rows only."""
    path = os.path.join(ECLIPSE, "Eclipse", "packs", line, line + ".ecap")
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        d = f.read()
    _m, _v, nc, na, _ns, _nf, _nb = struct.unpack_from("<4sIIIIII", d, 0)
    apps = 28 + nc * 24
    out = set()
    for i in range(na):
        r = struct.unpack_from("<IIIIIIIHHHBBBBH", d, apps + i * 40)
        if r[10] == 0:
            out.add(r[2] & 0xFFFFFF)
    return out


def retail_mount_displays():
    """Retail mount display -> what the morph takes (Morph.h Outfit::mount).

    The DLL's retail line appends rows at its own ids, read from retailmounts.edb
    (EMDB v2, Row: display, source = retail display, ...). A classic mount keeps its
    id: the client's own table holds it, and the model name must agree."""
    out = {}
    path = os.path.join(ECLIPSE, "Eclipse", "packs", "retailmounts", "retailmounts.edb")
    if os.path.isfile(path):
        with open(path, "rb") as f:
            d = f.read()
        if d[:4] == b"EMDB":
            count = struct.unpack_from("<I", d, 8)[0]
            for i in range(count):
                display, source = struct.unpack_from("<II", d, 20 + i * 32)
                out[source] = display
    base = os.path.join(ECLIPSE, "re", "out", "dbc", "live")
    cdi = {r[0]: r[1] for r in Dbc(os.path.join(base, "CreatureDisplayInfo.dbc")).rows()}
    t = Dbc(os.path.join(base, "CreatureModelData.dbc"))
    paths = {r[0]: stem(t.text(r[2])) for r in t.rows()}
    fdid_stem = {}
    listfile = os.path.join(ECLIPSE, "re", "out", "hearth", "listfile.csv")
    with open(listfile, encoding="utf-8", errors="replace") as f:
        for line in f:
            fd, _, p = line.rstrip(chr(10)).partition(";")
            if p.lower().startswith("creature/") and p.lower().endswith(".m2"):
                fdid_stem[int(fd)] = stem(p)
    model_of = {int(r["ID"]): int(r["FileDataID"] or 0) for r in table("CreatureModelData", ("ID", "FileDataID"))}
    retail_model = {int(r["ID"]): int(r["ModelID"] or 0) for r in table("CreatureDisplayInfo", ("ID", "ModelID"))}
    wanted = {int(r["CreatureDisplayInfoID"]) for r in table("MountXDisplay", ("CreatureDisplayInfoID",))}
    for d in wanted:
        if d in out or d not in cdi:
            continue
        retail_stem = fdid_stem.get(model_of.get(retail_model.get(d, 0), 0), "")
        client_stem = paths.get(cdi[d], "")
        if retail_stem and retail_stem == client_stem:
            out[d] = d
    return out


def compact_rows(rows, retail, names):
    out = []
    for r in rows:
        name = names.get(r["entry"]) or retail.names.get(r["entry"]) or ""
        # The bake reads the name from ItemSparse when it is the same there: fewer bytes here.
        if name == retail.names.get(r["entry"]):
            name = ""
        out.append([r["entry"], r["display"], r["route"], r["inv"], r["cls"], r["sub"]] + ([name] if name else []))
    return out


def summarize(label, total, routes, unresolved, extra=""):
    print("%s: %d rows%s" % (label, total, extra))
    for i, name in enumerate(ROUTES):
        print("  %-12s %7d" % (name, routes.get(i, 0)))
    print("  %-12s %7d" % ("unresolved", len(unresolved)))
    step = max(1, len(unresolved) // 5)
    for r in unresolved[::step][:5]:
        print("    %d %s: %s" % (r["entry"], (r["models"] + r["tex"] + [""])[0] or r.get("icon", ""), r["why"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="print coverage, write nothing")
    args = ap.parse_args()
    t0 = time.time()
    listfile = read_listfile()
    print("listfile read, %d models, %d textures, %.1f s" % (len(listfile[0]), len(listfile[1]), time.time() - t0), file=sys.stderr)
    retail = Retail()
    files = Files(listfile)

    client = client_rows()
    routes_c, un_c = resolve_rows(client, retail, files)
    summarize("client", len(client), routes_c, un_c)

    realm, realm_sets, kinds = realm_rows()
    routes_e, un_e = resolve_rows(realm, retail, files)
    summarize("eclipse", len(realm), routes_e, un_e, " (of %d catalogue rows: %s)" % (sum(kinds.values()), dict(kinds)))

    names = read_item_names()
    resolved_c = [r for r in client if "display" in r]
    resolved_e = [r for r in realm if "display" in r]
    uniq = {
        "client": {r["display"] for r in resolved_c},
        "eclipse": {r["display"] for r in resolved_e},
    }
    print("unique retail displays: client %d, eclipse %d, union %d" % (len(uniq["client"]), len(uniq["eclipse"]), len(uniq["client"] | uniq["eclipse"])))
    if args.report:
        return 0

    by_entry_c = {r["entry"]: r["display"] for r in resolved_c}
    by_entry_e = {r["entry"]: r["display"] for r in resolved_e}
    out = {
        "build": BUILD,
        "routes": ROUTES,
        "client": {
            "rows": compact_rows(resolved_c, retail, names),
            "total": len(client),
            "routes": [routes_c.get(i, 0) for i in range(len(ROUTES))],
            "unresolved": len(un_c),
            "unresolvedSample": [[r["entry"], r["why"]] for r in un_c[:: max(1, len(un_c) // 5)][:5]],
            "sets": [[sid, name, [by_entry_c[i] for i in items if i in by_entry_c]] for sid, name, items in client_sets()],
        },
        "eclipse": {
            "rows": compact_rows(resolved_e, retail, names),
            "total": len(realm),
            "catalogueRows": sum(kinds.values()),
            "routes": [routes_e.get(i, 0) for i in range(len(ROUTES))],
            "unresolved": len(un_e),
            "unresolvedSample": [[r["entry"], r["why"]] for r in un_e[:: max(1, len(un_e) // 5)][:5]],
            "sets": [[sid, name, [by_entry_e[i] for i in items if i in by_entry_e]] for sid, name, items in realm_sets],
        },
        "entries": {line: sorted(ecap_displays(line) or []) for line in ("midnight", "warwithin")},
        "mounts": {str(k): v for k, v in sorted(retail_mount_displays().items())},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.GzipFile(OUT, "wb", compresslevel=9, mtime=0) as f:
        f.write(body)
    print("%s: %.2f MB raw, %.2f MB gzip" % (OUT, len(body) / 1e6, os.path.getsize(OUT) / 1e6))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
