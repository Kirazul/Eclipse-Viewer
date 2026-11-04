"""
What Eclipse's own code says a body offers and paints, as the baker's goldens.

    python bake/test/golden/gen_custom.py

Runs tools/races/races_spec.py load_tree and races_layers.mats_of against work/db2/
(the pinned build's tables this repo already caches), with Eclipse's file access stubbed
out: nothing is read from its re/out/. Writes bake/test/fixtures/golden-custom.json:

    { "<chrModel>": [{id, name, choices: [ids]}], ... , "looks": {"<chrModel>": [{look, mats}]} }

The choice lists include Eclipse's load-time colour-row rule (Races.cpp "A COLOUR ROW
LISTS COLOURS"). ECLIPSE_ROOT overrides where Eclipse lives.
"""
import csv
import json
import os
import random
import sys
import types

ROOT = os.environ.get("ECLIPSE_ROOT", "../Eclipse1")
sys.path[:0] = [ROOT + "/tools", ROOT + "/tools/lib", ROOT + "/tools/races"]

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
BUILD = "12.1.0.69933"
DB2 = os.path.join(REPO, "work", "db2", BUILD)
OUT = os.path.join(HERE, "..", "fixtures", "golden-custom.json")

# Eclipse's tree needs these only for paths and archive reads.
rf = types.ModuleType("retail_fetch")
rf.BUILD = BUILD
sys.modules["retail_fetch"] = rf
mf = types.ModuleType("races_manifest")
mf.all_races = lambda: []
mf.race = lambda key: None
mf.bodies = lambda keys=None: []
sys.modules["races_manifest"] = mf
sys.modules.setdefault("_toolpath", types.ModuleType("_toolpath"))
sys.modules["blp"] = types.ModuleType("blp")

import races_spec as S  # noqa: E402
import races_layers as RL  # noqa: E402


def table(name, db2=DB2):
    with open(os.path.join(DB2, name + ".csv"), encoding="utf-8") as f:
        return list(csv.DictReader(f))


S.table = table
S.OVERLAY_BUILDS = ()
RL.base_mats = lambda body: {}


class Body:
    """What mats_of reads of a races_spec.Body."""

    def __init__(self, model):
        self.opts = S.load_tree(model)
        self.layout = int(S.by_id("ChrModel")[str(model)]["CharComponentTextureLayoutID"])
        self.layers = S.layout_layers(self.layout)


def prune_colour_rows(opts):
    for o in opts:
        swatched, waits = False, True
        for c in o["choices"]:
            if not c["swatch"][0]:
                continue
            swatched = True
            for e in c["elems"]:
                if e["kind"] in ("mat", "geo", "skinned"):
                    waits = waits and e["cond"] != 0
        if not swatched or not waits:
            continue
        o["choices"] = [c for c in o["choices"] if c["swatch"][0]
                        or any(e["kind"] in ("mat", "geo", "skinned", "condmodel") for e in c["elems"])]


def main():
    out = {"looks": {}}
    for model in (1, 2, 3, 53, 89, 10):
        body = Body(model)
        rng = random.Random(model)
        looks = []
        for i in range(24):
            look = {o["id"]: (o["choices"][0] if i == 0 else rng.choice(o["choices"]))["id"] for o in body.opts}
            looks.append({"look": {str(k): v for k, v in look.items()},
                          "mats": {str(k): v for k, v in RL.mats_of(body, look).items() if v}})
        out["looks"][str(model)] = looks
        prune_colour_rows(body.opts)
        out[str(model)] = [{"id": o["id"], "name": o["name"], "choices": [c["id"] for c in o["choices"]]}
                           for o in body.opts]
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
