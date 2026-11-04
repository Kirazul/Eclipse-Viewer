/**
 * Which UV source each texture unit of a batch reads, from retail's shader id.
 * Port of Eclipse's tools/retailmounts/retail_programs.py (VS, TABLE,
 * vertex_program), which proved them against retail's own vertex shaders.
 *
 * Value: 0 = UV set 1, 1 = UV set 2, 2 = sphere map (the shader computes it, no
 * UVs). `texture_coord_combos` is empty in every retail model, so the shader id is
 * the only source of this.
 */

const VS: Record<string, readonly number[]> = {
  Diffuse_T1: [0],
  Diffuse_T2: [1],
  Diffuse_Env: [2],
  Diffuse_T1_T2: [0, 1],
  Diffuse_T1_Env: [0, 2],
  Diffuse_Env_T1: [2, 0],
  Diffuse_Env_Env: [2, 2],
  Diffuse_T1_Env_T1: [0, 2, 0],
  Diffuse_T1_T1: [0, 0],
  Diffuse_T1_T1_T1: [0, 0, 0],
  Diffuse_EdgeFade_T1: [0],
  Diffuse_EdgeFade_T1_T2: [0, 1],
  Diffuse_EdgeFade_Env: [2],
  Diffuse_T1_Env_T2: [0, 2, 1],
  Diffuse_T1_T2_T1: [0, 1, 0],
  Diffuse_T1_T2_T3: [0, 1, 1],
  Color_T1_T2_T3: [0, 1, 1],
  BW_Diffuse_T1: [0],
  BW_Diffuse_T1_T2: [0, 1],
};

/** Retail's shader table (id & 0x7FFF, for ids with the 0x8000 bit): vertex program of each row. */
const TABLE: readonly string[] = [
  "Diffuse_T1_Env",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env_T1",
  "Diffuse_T1_Env",
  "Diffuse_T1_T1",
  "Diffuse_T1_T1",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env_T1",
  "Diffuse_T1_T1",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env",
  "Diffuse_T1_T1",
  "Diffuse_T1_T2",
  "Diffuse_T1_Env",
  "Diffuse_T1_Env_T1",
  "Diffuse_T1",
  "Diffuse_EdgeFade_T1",
  "Diffuse_T1_Env_T2",
  "Diffuse_EdgeFade_T1_T2",
  "Diffuse_T1_T2",
  "Diffuse_T1_T1",
  "Diffuse_T1_Env_T2",
  "Diffuse_EdgeFade_Env",
  "Diffuse_T1_T2_T1",
  "Diffuse_T1_T2",
  "Diffuse_T1_T2_T1",
  "Diffuse_T1_T1",
  "Diffuse_T1_T2_T3",
  "Color_T1_T2_T3",
  "Diffuse_T1",
  "Diffuse_EdgeFade_T1_T2",
  "Diffuse_EdgeFade_T1",
  "Diffuse_EdgeFade_T1_T2",
];

function vertexProgram(textureCount: number, shader: number): string {
  if (shader & 0x8000) return TABLE[shader & 0x7fff] ?? "Diffuse_T1";
  if (textureCount === 1) {
    if (shader & 0x80) return "Diffuse_Env";
    return shader & 0x4000 ? "Diffuse_T2" : "Diffuse_T1";
  }
  if (shader & 0x80) return shader & 0x8 ? "Diffuse_Env_Env" : "Diffuse_Env_T1";
  if (shader & 0x8) return "Diffuse_T1_Env";
  return shader & 0x4000 ? "Diffuse_T1_T2" : "Diffuse_T1_T1";
}

/** Per unit: 0, 1 or 2 as above. A unit past the program's list reads UV set 1. */
export function unitUvSources(textureCount: number, shader: number): number[] {
  const list = VS[vertexProgram(textureCount, shader)] ?? [0];
  const out: number[] = [];
  for (let k = 0; k < textureCount; k++) out.push(list[k] ?? 0);
  return out;
}
