import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { salsa20 } from "./salsa20";

/** A block is encrypted with a key nobody has published. The file is reported, never guessed. */
export class BlteKeyMissing extends Error {
  constructor(public readonly keyName: string) {
    super(`BLTE block is encrypted with unknown key ${keyName}`);
    this.name = "BlteKeyMissing";
  }
}

export type TactKeys = (name: string) => Uint8Array | undefined;
const NO_KEYS: TactKeys = () => undefined;

/**
 * BLTE: one block when the header size is 0, else a table of blocks. Modes are
 * N (plain), Z (zlib), E (Salsa20, then a nested block) and F (a nested BLTE).
 * The table's checksum is the MD5 of the block as stored, verified here so a bad
 * byte range fails at the block that holds it.
 */
export function decodeBlte(d: Buffer, keys: TactKeys = NO_KEYS): Buffer {
  if (d.length < 8 || d.toString("latin1", 0, 4) !== "BLTE") {
    throw new Error(`not BLTE (starts ${d.subarray(0, 8).toString("hex")})`);
  }
  const headerSize = d.readUInt32BE(4);
  if (headerSize === 0) return decodeBlock(d.subarray(8), 0, keys);

  const flags = d[8]!;
  const count = d.readUIntBE(9, 3);
  if (flags !== 0x0f) throw new Error(`BLTE: unknown table flags 0x${flags.toString(16)}`);
  if (12 + count * 24 > headerSize) throw new Error(`BLTE: table of ${count} blocks overruns header ${headerSize}`);
  const out: Buffer[] = [];
  let p = headerSize;
  for (let i = 0; i < count; i++) {
    const row = 12 + i * 24;
    const cSize = d.readUInt32BE(row);
    const uSize = d.readUInt32BE(row + 4);
    if (p + cSize > d.length) throw new Error(`BLTE: block ${i} overruns the data`);
    const block = d.subarray(p, p + cSize);
    const sum = d.subarray(row + 8, row + 24);
    if (!createHash("md5").update(block).digest().equals(sum)) throw new Error(`BLTE: block ${i} fails its checksum`);
    const plain = decodeBlock(block, i, keys);
    if (plain.length !== uSize) throw new Error(`BLTE: block ${i} is ${plain.length} bytes, table says ${uSize}`);
    out.push(plain);
    p += cSize;
  }
  return Buffer.concat(out);
}

function decodeBlock(b: Buffer, index: number, keys: TactKeys): Buffer {
  const mode = String.fromCharCode(b[0]!);
  switch (mode) {
    case "N":
      return b.subarray(1);
    case "Z":
      return inflateSync(b.subarray(1));
    case "F":
      return decodeBlte(b.subarray(1), keys);
    case "E":
      return decodeBlock(decrypt(b, index, keys), index, keys);
    default:
      throw new Error(`BLTE: unknown block mode 0x${(b[0] ?? 0).toString(16)}`);
  }
}

function decrypt(b: Buffer, index: number, keys: TactKeys): Buffer {
  let o = 1;
  const keyLen = b[o++]!;
  const keyName = Buffer.from(b.subarray(o, o + keyLen)).reverse().toString("hex").toUpperCase();
  o += keyLen;
  const ivLen = b[o++]!;
  const iv = Buffer.alloc(8);
  b.copy(iv, 0, o, o + ivLen);
  o += ivLen;
  const kind = String.fromCharCode(b[o++]!);
  if (kind !== "S") throw new Error(`BLTE: encryption type ${kind} is not supported`);
  const key = keys(keyName);
  if (!key) throw new BlteKeyMissing(keyName);
  // The block index is xored into the IV.
  for (let s = 0; s < 4; s++) iv[s] = iv[s]! ^ ((index >>> (8 * s)) & 0xff);
  return Buffer.from(salsa20(key, iv, b.subarray(o)));
}

/** wowdev/TACTKeys WoW.txt: `<16 hex name> <32 hex key> ...` per line. */
export function parseTactKeys(text: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 2 && f[0]!.length === 16 && f[1]!.length === 32) {
      out.set(f[0]!.toUpperCase(), Buffer.from(f[1]!, "hex"));
    }
  }
  return out;
}
