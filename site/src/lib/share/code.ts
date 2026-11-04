/**
 * The share code: `ECA1:<base64 of exactly what mo::Serialize wrote>`
 * (src/eclipse/wardrobe/Share.cpp, src/eclipse/core/Storage.cpp).
 *
 * decode keeps the code it read, so a code nobody edited goes back out byte for byte,
 * whatever it holds that this build has never heard of.
 */
import { deserialize, writeBack, type Outfit } from "./outfit";

export const SHARE_TAG = "ECA1:";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REV: Record<string, number> = {};
for (let k = 0; k < 64; k++) REV[B64[k]!] = k;

/** ec::Base64Encode: the standard alphabet, always padded. `bytes` is a byte string. */
export function base64Encode(bytes: string): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes.charCodeAt(i) << 16) | (bytes.charCodeAt(i + 1) << 8) | bytes.charCodeAt(i + 2);
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + B64[(v >> 6) & 63]! + B64[v & 63]!;
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length;
    let v = bytes.charCodeAt(i) << 16;
    if (two) v |= bytes.charCodeAt(i + 1) << 8;
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + (two ? B64[(v >> 6) & 63]! : "=") + "=";
  }
  return out;
}

/** ec::Base64Decode: padding ends the data, any other stray byte fails it. */
export function base64Decode(text: string): string | null {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const c of text) {
    if (c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r") continue;
    if (c === "=") break;
    const v = REV[c];
    if (v === undefined) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

const below = (c: string) => c.charCodeAt(0) <= 32;

function trimmed(text: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && below(text[a]!)) a++;
  while (b > a && below(text[b - 1]!)) b--;
  return text.slice(a, b);
}

/** share::LooksLikeCode: lights Import up without having to press it. */
export function looksLikeCode(text: string | null | undefined): boolean {
  if (!text) return false;
  let a = 0;
  while (a < text.length && below(text[a]!)) a++;
  return text.slice(a, a + SHARE_TAG.length).toUpperCase() === SHARE_TAG;
}

/**
 * share::Decode. The tag may be absent or differently cased, whitespace anywhere is a
 * wrapped paste, and the first `~` ends the outfit: an old code's picture and labels
 * after it are not read, only kept for the way back.
 */
export function decode(text: string): Outfit | null {
  let s = trimmed(text);
  if (s.length >= SHARE_TAG.length && s.slice(0, SHARE_TAG.length).toUpperCase() === SHARE_TAG) s = s.slice(SHARE_TAG.length);
  let tail = "";
  const cut = s.indexOf("~");
  if (cut >= 0) {
    tail = s.slice(cut);
    s = s.slice(0, cut);
  }
  let clean = "";
  for (const c of s) if (!below(c)) clean += c;
  if (!clean) return null;
  const body = base64Decode(clean);
  if (!body) return null;
  const o = deserialize(body);
  o.source = { body, tail, written: writeBack(o) };
  return o;
}

/** share::Encode. An outfit decode read and nobody changed returns the code it came from. */
export function encode(o: Outfit): string {
  const written = writeBack(o);
  if (o.source && o.source.written === written) return SHARE_TAG + base64Encode(o.source.body) + o.source.tail;
  return SHARE_TAG + base64Encode(written);
}
