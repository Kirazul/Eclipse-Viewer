"""
Golden numbers on files invented here, so these tests run anywhere with no game data.

    python bake/test/golden/gen_synthetic.py

Writes bake/test/fixtures/synthetic.json:
  m2      a small MD21 model: three bones, one inline clip, one clip in a .anim, one
          alias, one track on a global loop
  anim    that .anim as AFM2 chunks, and animRaw the same keys in the raw form
  skin    a skin with two submeshes
  poses   Eclipse's tools/lib/m2_view.py bone_matrices at sampled times
  blps    small BLPs from Eclipse's tools/lib/blp.py, with its decode of each

ECLIPSE_ROOT overrides where Eclipse lives.
"""
import base64
import json
import os
import struct
import sys

ROOT = os.environ.get("ECLIPSE_ROOT", "C:/Users/XtremePc/Desktop/Eclipse1")
sys.path[:0] = [ROOT + "/tools", ROOT + "/tools/lib"]

import numpy as np  # noqa: E402
import blp  # noqa: E402
import m2model as M  # noqa: E402
import m2_view as V  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures", "synthetic.json")

ANIM_FDID = 7001


def b64(b):
    return base64.b64encode(bytes(b)).decode("ascii")


class Blob:
    """An MD20 body: the header, then arrays appended, each aligned to 16."""

    def __init__(self, size):
        self.b = bytearray(size)

    def add(self, data):
        while len(self.b) % 16:
            self.b.append(0)
        at = len(self.b)
        self.b += data
        return at


def q16_encode(v):
    # Inverse of m2_view.q16: (s < 0 ? s + 32768 : s - 32767) / 32767.
    s = round(v * 32767)
    return s - 32768 if s >= 0 else s + 32767


def quat(axis, deg):
    a = np.radians(deg) / 2
    u = np.array(axis, dtype=float)
    u = u / np.linalg.norm(u)
    return [*(u * np.sin(a)), np.cos(a)]


def keys_bytes(fmt, values):
    return b"".join(struct.pack(fmt, *(v if isinstance(v, (list, tuple)) else [v])) for v in values)


def build():
    """Bone 0: root with a moving pivot. Bone 1: rotates and scales. Bone 2: global loop."""
    pivots = [(0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.5, 0.0, 1.5)]
    parents = [-1, 0, 1]

    # Sequences: 0 inline, 1 external, 2 alias of 0.
    SEQS = [(0, 0, 1000, 0x20), (4, 0, 500, 0x00), (5, 0, 1000, 0x60)]

    # Per bone, per sequence: (times, values) of translation, rotation, scale.
    # Sequence 1's arrays live in the .anim. Sequence 2 is an alias and reads 0's.
    trans = {0: {0: ([0, 500, 1000], [(0, 0, 0), (0.25, 0, 0.5), (0, 0, 0)]),
                 1: ([0, 500], [(0, 0, 0), (1, 0, 0)])}}
    rots = {1: {0: ([0, 250, 1000], [quat((0, 1, 0), 0), quat((0, 1, 0), 60), quat((0, 1, 0), 0)]),
                1: ([0, 500], [quat((1, 0, 0), 0), quat((1, 0, 0), 90)])}}
    scales = {1: {0: ([0, 1000], [(1, 1, 1), (2, 1, 0.5)])}}

    blob = Blob(0x130)
    anim = bytearray()

    def add_anim(data):
        while len(anim) % 16:
            anim.append(0)
        at = len(anim)
        anim.extend(data)
        return at

    def track_arrays(table, fmt, encode):
        n = len(SEQS)
        times = bytearray(n * 8)
        values = bytearray(n * 8)
        for s in range(n):
            t = (table or {}).get(s if s != 2 else 0)
            if not t:
                continue
            ts = struct.pack("<%dI" % len(t[0]), *t[0])
            vs = keys_bytes(fmt, [encode(v) for v in t[1]])
            external = SEQS[s][3] & 0x20 == 0
            put = add_anim if external else blob.add
            struct.pack_into("<II", times, s * 8, len(t[0]), put(ts))
            struct.pack_into("<II", values, s * 8, len(t[1]), put(vs))
        return n, blob.add(bytes(times)), n, blob.add(bytes(values))

    def track(table, fmt, encode, interp=1, gseq=-1):
        tn, to, vn, vo = track_arrays(table, fmt, encode)
        return struct.pack("<HhIIII", interp, gseq, tn, to, vn, vo)

    def global_track():
        # One array, read at index 0 of the record's own buffer, on loop 0.
        ts = blob.add(struct.pack("<3I", 0, 200, 400))
        vs = blob.add(keys_bytes("<4h", [[q16_encode(c) for c in quat((0, 0, 1), d)] for d in (0, 45, 0)]))
        t_arr = blob.add(struct.pack("<II", 3, ts))
        v_arr = blob.add(struct.pack("<II", 3, vs))
        return struct.pack("<HhIIII", 1, 0, 1, t_arr, 1, v_arr)

    identity = lambda v: v  # noqa: E731
    q_enc = lambda v: [q16_encode(c) for c in v]  # noqa: E731
    bones = bytearray()
    for i in range(3):
        rec = struct.pack("<iIhHI", -1, 0, parents[i], 0, 0x1000 + i)
        rec += track(trans.get(i), "<3f", identity)
        rec += global_track() if i == 2 else track(rots.get(i), "<4h", q_enc)
        rec += track(scales.get(i), "<3f", identity)
        rec += struct.pack("<3f", *pivots[i])
        assert len(rec) == 88
        bones += rec

    seq_recs = bytearray()
    for i, (aid, var, dur, flags) in enumerate(SEQS):
        rec = struct.pack("<HHIfIhHIII", aid, var, dur, 0.0, flags, 32767, 0, 0, 0, 150)
        rec += struct.pack("<7f", 0, 0, 0, 0, 0, 0, 0)
        rec += struct.pack("<hH", -1, 0)
        assert len(rec) == 64
        seq_recs += rec

    # Four vertices, weighted to bones 0-2; the second pair shares two bones.
    verts = bytearray()
    for p, w, j in [((0, 0, 0), (255, 0, 0, 0), (0, 0, 0, 0)),
                    ((0, 0, 1), (128, 127, 0, 0), (0, 1, 0, 0)),
                    ((0, 0, 2), (0, 255, 0, 0), (0, 1, 0, 0)),
                    ((0.5, 0, 2), (0, 100, 155, 0), (0, 1, 2, 0))]:
        verts += struct.pack("<3f4B4B3f2f2f", *p, *w, *j, 0, 0, 1, 0.25, 0.75, 0, 0)
    assert len(verts) == 4 * 48

    gloops = struct.pack("<I", 400)
    set_arr = lambda off, n, at: struct.pack_into("<II", blob.b, off, n, at)  # noqa: E731
    set_arr(0x14, 1, blob.add(gloops))
    set_arr(0x1C, len(SEQS), blob.add(bytes(seq_recs)))
    set_arr(0x2C, 3, blob.add(bytes(bones)))
    set_arr(0x3C, 4, blob.add(bytes(verts)))
    # Two textures (a hard-coded one and a skin), one material, the lookups.
    tex = bytearray()
    tex += struct.pack("<IIII", 0, 3, 0, 0) + struct.pack("<IIII", 1, 0, 0, 0)
    set_arr(0x50, 2, blob.add(bytes(tex)))
    set_arr(0x70, 1, blob.add(struct.pack("<HH", 4, 2)))
    set_arr(0x80, 2, blob.add(struct.pack("<2h", 0, 1)))
    set_arr(0x90, 1, blob.add(struct.pack("<h", 0)))
    set_arr(0x98, 2, blob.add(struct.pack("<2h", -1, -1)))
    blob.b[0:4] = b"MD20"
    struct.pack_into("<I", blob.b, 4, 274)

    md = bytes(blob.b)
    chunks = bytearray()
    for magic, body in ((b"MD21", md), (b"SFID", struct.pack("<I", 7002)), (b"TXID", struct.pack("<2I", 7003, 0)),
                        (b"AFID", struct.pack("<HHI", 4, 0, ANIM_FDID))):
        chunks += magic + struct.pack("<I", len(body)) + body
    return bytes(chunks), bytes(anim)


def build_skin():
    lookup = struct.pack("<4H", 0, 1, 2, 3)
    tris = struct.pack("<6H", 0, 1, 2, 1, 2, 3)
    subs = bytearray()
    # id, level, vstart, vcount, istart, icount, bcount, bstart, binf, center bone, centers
    subs += struct.pack("<10H", 0, 0, 0, 3, 0, 3, 2, 0, 2, 0) + bytes(28)
    subs += struct.pack("<10H", 401, 0, 1, 3, 3, 3, 3, 0, 3, 0) + bytes(28)
    batches = bytearray()
    # flags, priority, shader, submesh, geoset, colour, material, layer, tex count, tex combo,
    # coord combo, weight combo, transform combo
    batches += struct.pack("<BbHHHhHHHHHHH", 16, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0xFFFF, 0, 0)
    batches += struct.pack("<BbHHHhHHHHHHH", 16, 1, 0x4011, 1, 0, -1, 0, 0, 2, 0, 0xFFFF, 0, 0)
    head = 48
    o_look = head
    o_tris = o_look + len(lookup) + (16 - (len(lookup) % 16)) % 16
    o_subs = o_tris + len(tris) + (16 - (len(tris) % 16)) % 16
    o_bats = o_subs + len(subs)
    out = bytearray(o_bats + len(batches))
    out[0:4] = b"SKIN"
    struct.pack_into("<11I", out, 4, 4, o_look, 6, o_tris, 0, 0, 2, o_subs, 2, o_bats, 0)
    out[o_look:o_look + len(lookup)] = lookup
    out[o_tris:o_tris + len(tris)] = tris
    out[o_subs:o_subs + len(subs)] = subs
    out[o_bats:o_bats + len(batches)] = batches
    return bytes(out)


def gradient(w, h):
    img = np.zeros((h, w, 4), np.uint8)
    for y in range(h):
        for x in range(w):
            img[y, x] = (x * 255 // max(1, w - 1), y * 255 // max(1, h - 1), (x ^ y) * 16 % 256, 255 - x * 255 // max(1, w - 1))
    return img


def main():
    m2, anim = build()
    chunked = b"AFM2" + struct.pack("<I", len(anim)) + anim
    files = {ANIM_FDID: chunked}
    model = M.read_retail(m2, None, lambda f: files.get(f))
    poses = []
    for seq, dur in ((0, 1000), (1, 500)):
        for t in (0, dur * 0.1, dur * 0.25, dur * 0.5, dur * 0.8, dur):
            mats = V.bone_matrices(model, seq, t)
            poses.append({"seq": seq, "t": t, "matrices": [[float(x) for x in m[:3, :4].reshape(-1)] for m in mats]})
    blps = []
    square = gradient(8, 8)
    opaque = square.copy()
    opaque[..., 3] = 255
    for name, data in (
        ("dxt1", blp.encode(opaque, "dxt1")),
        ("dxt3", blp.encode(square, "dxt3")),
        ("dxt5", blp.encode(square, "dxt5")),
        ("palette", blp.encode_palette(square)),
    ):
        blps.append({"name": name, "blp": b64(data), "w": 8, "h": 8, "rgba": b64(blp.decode(data).tobytes()),
                     "level1": b64(blp.decode(blp.level_only(data, 1)).tobytes())})

    # Raw BGRA (encoding 3), written here: Eclipse's encoder never makes it.
    head = bytearray(148)
    head[0:4] = b"BLP2"
    struct.pack_into("<IBBBB", head, 4, 1, 3, 8, 0, 0)
    struct.pack_into("<II", head, 12, 2, 2)
    struct.pack_into("<16I", head, 20, 148 + 1024, *([0] * 15))
    struct.pack_into("<16I", head, 84, 16, *([0] * 15))
    bgra = bytes(head) + bytes(1024) + bytes([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160])
    blps.append({"name": "bgra", "blp": b64(bgra), "w": 2, "h": 2, "rgba": b64(blp.decode(bgra).tobytes())})

    out = {"m2": b64(m2), "anim": b64(chunked), "animRaw": b64(anim), "animFdid": ANIM_FDID, "skin": b64(build_skin()), "poses": poses, "blps": blps}
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
