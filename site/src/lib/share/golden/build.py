r"""Build the share-code harness out of Eclipse's REAL sources, unedited.

    python site/src/lib/share/golden/build.py    -> work/share-harness/share_harness.exe

The Eclipse repo is read only: nothing is written into it. It is found through
ECLIPSE_REPO, or as a folder beside this repo holding src/eclipse/wardrobe/Morph.cpp.

The method is the wardrobe preview's (tools/tests/wardrobe_preview/build.py): MSVC
x86, the DLL's own defines, link once without stubs, and whatever the linker cannot
resolve gets a zero-returning stub written by that folder's stubgen.py. What is real
here is everything a share code passes through: mo::Serialize and mo::Deserialize
(Morph.cpp), share::Encode, Decode and LooksLikeCode (Share.cpp), Base64 (Storage.cpp),
cc::Serialize and cc::Deserialize (CharCustom.cpp), races::Serialize and
races::Deserialize (Races.cpp), the skin presets (SkinCatalog.cpp) and the portable
display ids (TableMerge.cpp).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True      # nothing lands in the Eclipse repo, not even a cache

HERE = Path(__file__).resolve().parent
VIEWER = HERE.parents[4]


def find_eclipse() -> Path:
    env = os.environ.get("ECLIPSE_REPO")
    guesses = [Path(env)] if env else [p for p in VIEWER.parent.iterdir() if p.is_dir()]
    for p in guesses:
        if (p / "src" / "eclipse" / "wardrobe" / "Morph.cpp").is_file():
            return p
    raise SystemExit("Eclipse repo not found: set ECLIPSE_REPO")


ECLIPSE = find_eclipse()
OUT = VIEWER / "work" / "share-harness"
OBJ = OUT / "obj"
sys.path.insert(0, str(ECLIPSE / "tools" / "lib"))
sys.path.insert(0, str(ECLIPSE / "tools" / "tests" / "wardrobe_preview"))
import msvc  # noqa: E402

E = ECLIPSE / "src" / "eclipse"
SOURCES = [
    HERE / "harness.cpp",
    HERE / "races_tu.cpp",          # Races.cpp itself, with a door for the manifest
    HERE / "morph_tu.cpp",          # Morph.cpp itself, with a door for the barber's chair
    E / "wardrobe" / "Share.cpp",
    E / "core" / "Storage.cpp",
    E / "races" / "CharCustom.cpp",
    E / "skins" / "SkinCatalog.cpp",
    E / "client" / "TableMerge.cpp",
]
INCLUDES = ["src/include", "src"] + ["src/eclipse/" + d for d in sorted(
    p.name for p in E.iterdir() if p.is_dir())] + ["third_party", "third_party/imgui", "third_party/imgui/backends"]
# build.ps1's defines and CRT, so printf and scanf are the DLL's static UCRT.
DEFINES = ["WIN32_LEAN_AND_MEAN", "NOMINMAX", "_CRT_SECURE_NO_WARNINGS", "ECLIPSE_PROXY_DLL=1", "NDEBUG"]
LIBS = "d3d9.lib user32.lib gdi32.lib advapi32.lib shell32.lib ole32.lib ws2_32.lib winhttp.lib bcrypt.lib crypt32.lib dbghelp.lib psapi.lib"
EXE = "share_harness.exe"


def run(cmd: str) -> tuple[int, str]:
    env = dict(os.environ, VSLANG="1033")
    full = 'call "%s" >nul 2>&1 && cd /d "%s" && %s' % (msvc.vcvars32(), OBJ, cmd)
    p = subprocess.run(full, shell=True, capture_output=True, text=True, env=env, encoding="utf-8", errors="replace")
    return p.returncode, p.stdout + p.stderr


def obj_of(src: Path) -> Path:
    return OBJ / (src.stem + ".obj")


def compile_(sources: list[Path]) -> None:
    if not sources:
        return
    inc = " ".join('/I"%s"' % (ECLIPSE / i) for i in INCLUDES)
    dfn = " ".join("/D%s" % d for d in DEFINES)
    files = " ".join('"%s"' % s for s in sources)
    code, out = run("cl /nologo /c /MP /O2 /MT /EHsc /std:c++17 /utf-8 /bigobj /W1 %s %s %s" % (dfn, inc, files))
    if code:
        print("\n".join(l for l in out.splitlines() if "error" in l or "fatal" in l)[:8000])
        raise SystemExit("compile failed")


def link(objs: list[Path]) -> tuple[int, str]:
    files = " ".join('"%s"' % o.name for o in objs)
    # Based high and fixed, like the preview: the client's own range stays free.
    return run("link /nologo /BASE:0x20000000 /DYNAMICBASE:NO /FIXED /SUBSYSTEM:CONSOLE /MAP:..\\share_harness.map "
               "/OUT:..\\%s %s %s" % (EXE, files, LIBS))


def unresolved(log: str) -> list[str]:
    names = set()
    for line in log.splitlines():
        m = re.search(r'(?:unresolved external symbol|externe non r.solu) "(.*?)" \(', line)
        if m:
            names.add(m.group(1))
    return sorted(names)


def main() -> int:
    OBJ.mkdir(parents=True, exist_ok=True)
    objs = [obj_of(s) for s in SOURCES]
    oldest = min((o.stat().st_mtime for o in objs if o.exists()), default=0.0)
    headers = max(h.stat().st_mtime for h in (ECLIPSE / "src").rglob("*.h"))
    # A door file IS the source it includes: that source moving makes it stale too.
    inside = {"races_tu": E / "races" / "Races.cpp", "morph_tu": E / "wardrobe" / "Morph.cpp"}
    stale = [s for s in SOURCES
             if not obj_of(s).exists() or headers > oldest
             or max(s.stat().st_mtime, inside[s.stem].stat().st_mtime if s.stem in inside else 0) > obj_of(s).stat().st_mtime]
    print("compiling %d of %d sources" % (len(stale), len(SOURCES)))
    compile_(stale)

    code, log = link(objs)
    missing = unresolved(log)
    if code and not missing:
        print(log[-3000:])
        raise SystemExit("link failed")
    import stubgen
    stubs = OUT / "stubs.cpp"
    (OUT / "unresolved.txt").write_text("\n".join(missing) + "\n", encoding="utf-8")
    # stubgen's paths point into the Eclipse repo; here they point into work/.
    stubgen.SRC = OUT / "unresolved.txt"
    stubgen.OUT = stubs
    stubgen.main()
    # Types stubgen's two includes don't reach, for this source list.
    text = stubs.read_text(encoding="utf-8")
    text = text.replace('#include "Eclipse.h"', '#include "Eclipse.h"\n#include "MountSkinCore.h"\n#include "GarmentBind.h"', 1)
    # The header declares this one with no size, so decltype has none to give it.
    text = text.replace("decltype(wow::ec::perf::g_slotMs) wow::ec::perf::g_slotMs{};", "double wow::ec::perf::g_slotMs[64] = {};")
    stubs.write_text(text, encoding="utf-8")
    compile_([stubs])
    code, log = link(objs + [obj_of(stubs)])
    if code:
        print(log[-5000:])
        raise SystemExit("link failed")
    print("ok: %s (%d stubs)" % (OUT / EXE, len(missing)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
