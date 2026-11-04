"""
Golden poses for Human male, from Eclipse's own evaluator (tools/lib/m2_view.py).

    python bake/test/golden/gen_human_male.py

Reads the pinned raw files from work/raw/<build>/ and writes
bake/test/fixtures/golden-human-male.json: bone matrices and skinned vertices at
sampled times of three clips. The numbers are Eclipse's, untouched, in retail
space. The test applies the coordinate change itself.

ECLIPSE_ROOT overrides where Eclipse lives.
"""
import json
import os
import struct
import sys

ROOT = os.environ.get("ECLIPSE_ROOT", "C:/Users/XtremePc/Desktop/Eclipse1")
sys.path[:0] = [ROOT + "/tools", ROOT + "/tools/lib"]

import numpy as np  # noqa: E402
import m2model as M  # noqa: E402
import m2_view as V  # noqa: E402
import retail_m2 as RM  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
BUILD = "12.1.0.69933"
RAW = os.path.join(REPO, "work", "raw", BUILD)
OUT = os.path.join(HERE, "..", "fixtures", "golden-human-male.json")

M2_FDID = 1011653
# Inline clips and one from a .anim file.
CLIPS = [(0, 0), (5, 0), (60, 0)]
# The default look's geosets the baker must resolve to, for picking sample vertices.
GEOSETS = {0, 401, 501, 702, 1301, 1801, 2001, 2201, 3202, 3301, 5101}


def read(fdid):
    with open(os.path.join(RAW, str(fdid)), "rb") as f:
        return f.read()


def round_list(a, digits):
    return [round(float(x), digits) for x in np.asarray(a).reshape(-1)]


def main():
    m2 = read(M2_FDID)
    deps = RM.deps(m2)
    skel = read(deps["skel"][0])
    model = M.read_retail(m2, skel, read)
    skin = RM.skin(read(deps["skin"][0]))

    verts = model.a["verts"]
    look = skin["lookup"]

    # Every ninth bone, so the chain from root to hand is well covered.
    bones = list(range(0, len(model.a["bones"]), 9))

    # Evenly spaced lookup indices, drawn from what the default look shows.
    shown = sorted({skin["tris"][k] for s in skin["subs"] if s["id"] in GEOSETS
                    for k in range(s["istart"], s["istart"] + s["icount"])})
    samples = shown[:: max(1, len(shown) // 100)][:100]

    out = {
        "note": "Eclipse tools/lib/m2_view.py, retail space. See gen_human_male.py.",
        "build": BUILD,
        "bones": bones,
        "parents": [b["parent"] for b in model.a["bones"]],
        "vertices": [],
        "clips": [],
    }
    for li in samples:
        raw = verts[look[li]]
        out["vertices"].append({
            "bind": round_list(struct.unpack_from("<3f", raw, 0), 6),
            "weights": list(struct.unpack_from("<4B", raw, 12)),
            "joints": list(struct.unpack_from("<4B", raw, 16)),
        })

    for anim_id, var in CLIPS:
        seq = V.seq_index(model, anim_id, var)
        dur = model.seq_field(seq, "dur")
        n = max(1, round(dur / 1000 * 30))
        # Key times of the baked grid, and one point between two keys.
        ks = [0, n // 3, 2 * n // 3, n]
        times = [("key", k * dur / n) for k in ks] + [("mid", (n // 3 + 0.5) * dur / n)]
        poses = []
        for kind, t in times:
            mats = V.bone_matrices(model, seq, t)
            pos = V.mesh(model, skin, GEOSETS, mats)[0]
            poses.append({
                "kind": kind,
                "t": t,
                # The top three rows of each sampled bone's matrix.
                "matrices": [round_list(mats[b][:3, :4], 6) for b in bones],
                "vertices": round_list(pos[samples], 5),
            })
        out["clips"].append({"id": "%d.%d" % (anim_id, var), "durationMs": dur, "poses": poses})

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
