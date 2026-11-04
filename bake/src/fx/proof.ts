/**
 * Bakes one model straight from its FileDataID, for proving particles, ribbons and
 * physics on a slow line. The real mount and item routes are in bake/src/mounts and
 * bake/src/items; this one looks at nothing but the file and, for a creature, the first
 * display that uses it.
 *
 *   npx tsx bake/src/fx/proof.ts 3931416 [more ids]
 *
 * Reads through work/raw (wago), writes to site/public/packs as `fx-<fdid>`. Set
 * ECLIPSE_ART to a folder of raw files by FileDataID to use those first.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelManifest, TextureEntry } from "@eclipse/format";
import { openContext } from "../bake/context";
import { bakeModel, blankTexture, kindOf } from "../bake/model";
import { bakeTexture } from "../bake/texture";
import { num } from "../db2/db2";
import { particleColorsOf } from "./emitters";
import { humanBytes, log, md5Hex } from "../lib/env";
import { type GameSource, MissingFile, type SourceFile, isAllZero } from "../sources/source";
import { openStore } from "../store/store";

/** The local art folder first, then the usual source. */
class Layered implements GameSource {
  readonly name = "wago" as const;

  constructor(
    private readonly dir: string,
    private readonly next: GameSource,
  ) {}

  private local(fdid: number): Buffer | null {
    const p = join(this.dir, String(fdid));
    if (!existsSync(p)) return null;
    const b = readFileSync(p);
    return b.length === 0 || isAllZero(b) ? null : b;
  }

  async read(fdid: number): Promise<SourceFile> {
    const hit = this.local(fdid);
    if (hit) return { bytes: hit, id: md5Hex(hit) };
    return this.next.read(fdid);
  }

  async identity(fdid: number): Promise<string | null> {
    const hit = this.local(fdid);
    return hit ? md5Hex(hit) : this.next.identity(fdid);
  }
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (ids.length === 0) throw new Error("usage: proof.ts <m2 FileDataID>...");
  const ctx = openContext("wago", openStore(false), process.env.FORCE === "1");
  const art = process.env.ECLIPSE_ART;
  if (art) ctx.source = new Layered(art, ctx.source);

  for (const fdid of ids) {
    // A creature's textures of type 11..13 come from its display.
    const variation: number[] = [];
    let display = "";
    let particleColor = 0;
    const models = await ctx.db.where("CreatureModelData", "FileDataID", fdid);
    if (models[0]) {
      const rows = await ctx.db.where("CreatureDisplayInfo", "ModelID", models[0].ID ?? "");
      const row = rows[0];
      if (row) {
        display = row.ID ?? "";
        particleColor = num(row.ParticleColorID);
        for (let k = 0; k < 4; k++) variation.push(num(row[`TextureVariationFileDataID_${k}`]));
      }
    }
    const started = Date.now();
    const baked = await bakeModel(ctx, {
      id: `fx-${fdid}`,
      kind: "mount",
      name: `Proof ${fdid}`,
      m2: fdid,
      look: async (model, skin, files) => {
        const warnings: string[] = [];
        const textures: TextureEntry[] = [];
        for (const tex of model.textures) {
          const want = tex.type === 0 ? tex.fileDataId : tex.type >= 11 && tex.type <= 13 ? (variation[tex.type - 11] ?? 0) : 0;
          if (!want) {
            textures.push(blankTexture(tex.type));
            continue;
          }
          try {
            const t = await bakeTexture(ctx, files, want, { cap: 1024 });
            textures.push({ type: tex.type, kind: kindOf(tex.type), key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: want });
          } catch (e) {
            if (!(e instanceof MissingFile)) throw e;
            warnings.push(`texture ${want}: ${e.message}`);
            textures.push(blankTexture(tex.type));
          }
        }
        const particleColors = await particleColorsOf(ctx.db, model, particleColor);
        return { geosets: new Set(skin.submeshes.map((s) => s.id)), textures, warnings, ...(particleColors ? { manifest: { particleColors } } : {}) };
      },
    });
    const m: ModelManifest = baked.manifest;
    const fxBytes = m.fx?.bytes ?? 0;
    log(`fx-${fdid}${display ? ` (display ${display})` : ""}: ${m.clips.length} clip(s), glb ${humanBytes(m.glb.bytes)}, fx ${humanBytes(fxBytes)}, phys ${humanBytes(m.phys?.bytes ?? 0)}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    for (const w of m.warnings) log(`  ${w}`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
