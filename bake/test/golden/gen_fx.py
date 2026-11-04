"""
Golden numbers for bake/src/fx, from Eclipse's own pipeline rather than from this one:
its shipped tables Eclipse/packs/retailmounts/retailmounts_ptcl.bin (ERMP v2) and
retailmounts_rbn.bin (ERMR v1), written by tools/retailmounts/mount_convert.py and read
by the DLL.

    python bake/test/golden/gen_fx.py <Eclipse repo> bake/test/fixtures/fx-golden.json

Each model is keyed by stem; the test reads the same FileDataID's M2 from work/raw.
"""
import json
import os
import struct
import sys

MODELS = {"progenitorwolf": 3931416, "owldragonmount": 5633991, "magicalowlbearmount": 4693904}


def ermp(path):
    d = open(path, "rb").read()
    magic, ver, models, emitters, keys, strb, _stamp = struct.unpack_from("<4s6I", d, 0)
    assert magic == b"ERMP" and ver == 2
    mo = 28
    ro = mo + models * 12
    ko = ro + emitters * 64
    so = ko + keys * 4
    strs = d[so:so + strb]
    out = {}
    for i in range(models):
        k, first, count = struct.unpack_from("<3I", d, mo + i * 12)
        name = strs[k:strs.index(b"\0", k)].decode("latin1").rsplit("\\", 1)[-1]
        rows = []
        for j in range(first, first + count):
            r = struct.unpack_from("<HBBHH2f4f4ffIHHBBBB", d, ro + j * 64)
            index, flags, mat, t1, t2 = r[:5]
            scale = list(r[5:7])
            p0 = list(r[7:11])
            p1 = list(r[11:15])
            cm, first_key, nkeys, geoset, fx, rows_, cols, _pad = r[15:23]
            cut = [list(struct.unpack_from("<hh", d, ko + (first_key + q) * 4)) for q in range(nkeys)]
            rows.append(dict(index=index, three=flags & 1, mat=mat, t1=t1, t2=t2, scale=scale, p0=p0, p1=p1,
                             colorMult=cm, cut=cut, fx=fx))
        out[name] = rows
    return out


def ermr(path):
    d = open(path, "rb").read()
    magic, ver, models, ribbons, strb, _stamp = struct.unpack_from("<4s5I", d, 0)
    assert magic == b"ERMR" and ver == 1
    mo = 24
    ro = mo + models * 12
    so = ro + ribbons * 56
    strs = d[so:so + strb]
    out = {}
    for i in range(models):
        k, first, count = struct.unpack_from("<3I", d, mo + i * 12)
        name = strs[k:strs.index(b"\0", k)].decode("latin1").rsplit("\\", 1)[-1]
        rows = []
        for j in range(first, first + count):
            r = struct.unpack_from("<4H12f", d, ro + j * 56)
            rows.append(dict(index=r[0], t1=r[2], t2=r[3], scale=[list(r[4 + 2 * k_:6 + 2 * k_]) for k_ in range(3)],
                             speed=[list(r[10 + 2 * k_:12 + 2 * k_]) for k_ in range(3)]))
        out[name] = rows
    return out


def main():
    root, dest = sys.argv[1], sys.argv[2]
    packs = os.path.join(root, "Eclipse", "packs", "retailmounts")
    particles = ermp(os.path.join(packs, "retailmounts_ptcl.bin"))
    ribbons = ermr(os.path.join(packs, "retailmounts_rbn.bin"))
    out = {}
    for stem, fdid in MODELS.items():
        out[str(fdid)] = dict(stem=stem, particles=particles[stem], ribbons=ribbons.get(stem, []))
    with open(dest, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(dest, os.path.getsize(dest), "bytes")


if __name__ == "__main__":
    main()
