/**
 * The load check every object passes as it is written, on the bytes themselves, with no
 * GPU and no network: what would stop a browser at the door. A bad object is written
 * anyway, with its mark, so the item that names it is left out and counted instead of
 * reaching the site and failing there.
 */

const KTX2_ID = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

export function checkGlb(b: Uint8Array): boolean {
  if (b.length < 28) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(0, true) !== 0x46546c67 || v.getUint32(4, true) !== 2) return false;
  if (v.getUint32(8, true) !== b.length) return false;
  const jsonLength = v.getUint32(12, true);
  if (v.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > b.length) return false;
  try {
    const gltf = JSON.parse(Buffer.from(b.buffer, b.byteOffset + 20, jsonLength).toString("utf8")) as { asset?: unknown; buffers?: { byteLength?: number }[] };
    return gltf.asset !== undefined && (gltf.buffers ?? []).every((x) => (x.byteLength ?? 0) >= 0);
  } catch {
    return false;
  }
}

export function checkKtx2(b: Uint8Array): boolean {
  if (b.length < 80) return false;
  for (let i = 0; i < KTX2_ID.length; i++) if (b[i] !== KTX2_ID[i]) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = v.getUint32(20, true);
  const h = v.getUint32(24, true);
  return w > 0 && h > 0 && w <= 16384 && h <= 16384;
}

export function checkWebp(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  return Buffer.from(b.buffer, b.byteOffset, 4).toString("latin1") === "RIFF" && Buffer.from(b.buffer, b.byteOffset + 8, 4).toString("latin1") === "WEBP";
}

export function checkJson(b: Uint8Array): boolean {
  try {
    JSON.parse(Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

export function checkObject(key: string, body: Uint8Array): boolean {
  if (body.length === 0) return false;
  if (key.endsWith(".glb")) return checkGlb(body);
  if (key.endsWith(".ktx2")) return checkKtx2(body);
  if (key.endsWith(".webp")) return checkWebp(body);
  if (key.endsWith(".json")) return checkJson(body);
  return true;
}
