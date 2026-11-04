/**
 * Salsa20/20, the stream cipher TACT uses for BLTE mode `E`. Node's crypto has
 * ChaCha20 but not Salsa20. Works on keys of 16 or 32 bytes and an 8-byte nonce.
 */

function rotl(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function core(input: Uint32Array, out: Uint8Array): void {
  const x = input.slice();
  for (let i = 0; i < 10; i++) {
    const q = (a: number, b: number, c: number, d: number) => {
      x[b] = (x[b]! ^ rotl((x[a]! + x[d]!) >>> 0, 7)) >>> 0;
      x[c] = (x[c]! ^ rotl((x[b]! + x[a]!) >>> 0, 9)) >>> 0;
      x[d] = (x[d]! ^ rotl((x[c]! + x[b]!) >>> 0, 13)) >>> 0;
      x[a] = (x[a]! ^ rotl((x[d]! + x[c]!) >>> 0, 18)) >>> 0;
    };
    q(0, 4, 8, 12);
    q(5, 9, 13, 1);
    q(10, 14, 2, 6);
    q(15, 3, 7, 11);
    q(0, 1, 2, 3);
    q(5, 6, 7, 4);
    q(10, 11, 8, 9);
    q(15, 12, 13, 14);
  }
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < 16; i++) view.setUint32(i * 4, (x[i]! + input[i]!) >>> 0, true);
}

export function salsa20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 16 && key.length !== 32) throw new Error(`salsa20: key must be 16 or 32 bytes, got ${key.length}`);
  if (nonce.length !== 8) throw new Error(`salsa20: nonce must be 8 bytes, got ${nonce.length}`);
  const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const sigma = new TextEncoder().encode(key.length === 32 ? "expand 32-byte k" : "expand 16-byte k");
  const sv = new DataView(sigma.buffer);
  const hi = key.length === 32 ? 16 : 0;
  const st = new Uint32Array(16);
  st[0] = sv.getUint32(0, true);
  for (let i = 0; i < 4; i++) st[1 + i] = kv.getUint32(i * 4, true);
  st[5] = sv.getUint32(4, true);
  st[6] = nv.getUint32(0, true);
  st[7] = nv.getUint32(4, true);
  st[8] = 0;
  st[9] = 0;
  st[10] = sv.getUint32(8, true);
  for (let i = 0; i < 4; i++) st[11 + i] = kv.getUint32(hi + i * 4, true);
  st[15] = sv.getUint32(12, true);

  const out = new Uint8Array(data.length);
  const block = new Uint8Array(64);
  for (let off = 0; off < data.length; off += 64) {
    core(st, block);
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i]! ^ block[i]!;
    st[8] = (st[8]! + 1) >>> 0;
    if (st[8] === 0) st[9] = (st[9]! + 1) >>> 0;
  }
  return out;
}
