/**
 * The two C library behaviours a share code depends on, exactly: MSVC's static UCRT
 * sscanf_s and printf("%.Nf"). `golden/` proves both against the real CRT, including
 * ties, overflow and hostile input. JS's toFixed and parseFloat are not close enough:
 * toFixed rounds an exact tie up where the UCRT rounds it to even, and parseFloat plus
 * fround rounds twice.
 */

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";

const MASK32 = 0xffffffffn;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const U64_MAX = (1n << 64n) - 1n;

export interface Scan {
  /** What sscanf returns: conversions stored, or -1 when input ran out before the first. */
  count: number;
  /** Stored values in order. %d is signed, %u and %x are unsigned, %f is a float32, %s a string. */
  values: (number | string)[];
  /** The position %n would store: how far the scan got. */
  pos: number;
}

/** Reads digits at `at`; 64-bit, saturating on overflow, as UCRT's parse_integer<uint64_t>. */
function scanInteger(s: string, at: number, base: 10 | 16, signed: boolean): { value: bigint; end: number } | null {
  let i = at;
  let negative = false;
  if (s[i] === "-" || s[i] === "+") {
    negative = s[i] === "-";
    i++;
  }
  if (base === 16 && s[i] === "0" && (s[i + 1] === "x" || s[i + 1] === "X")) i += 2;
  const from = i;
  let n = 0n;
  const big = BigInt(base);
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const d = c >= 48 && c <= 57 ? c - 48 : base === 16 && c >= 97 && c <= 102 ? c - 87 : base === 16 && c >= 65 && c <= 70 ? c - 55 : -1;
    if (d < 0) break;
    n = n * big + BigInt(d);
  }
  if (i === from) return null;
  let value: bigint;
  if (signed) value = negative ? (n > -I64_MIN ? I64_MIN : -n) : n > I64_MAX ? I64_MAX : n;
  else value = n > U64_MAX ? U64_MAX : negative ? -n : n;
  return { value, end: i };
}

const FLOAT = /^[+-]?(?:inf(?:inity)?|nan(?:\([0-9a-z_]*\))?|0x(?:[0-9a-f]+\.?[0-9a-f]*|\.[0-9a-f]+)(?:p[+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i;
/** The real parser has committed to an exponent by then: "1e" is a failed conversion, not a 1. */
const BROKEN_EXPONENT = /^(?:\d+\.?\d*|\.\d+)e(?:[+-](?!\d)|(?![+\-\d]))/i;

/** num/den, to the nearest float32, ties to even. */
function ratioToFloat32(num: bigint, den: bigint): number {
  if (num === 0n) return 0;
  // The binary exponent of the leading bit, within one, from the lengths alone.
  let e = num.toString(2).length - den.toString(2).length - 24;
  const scaled = (x: number): [bigint, bigint] => (x >= 0 ? [num, den << BigInt(x)] : [num << BigInt(-x), den]);
  for (;;) {
    const [a, b] = scaled(e);
    const q = a / b;
    if (q >= 1n << 24n) e++;
    else if (q < 1n << 23n && e > -149) e--;
    else break;
  }
  if (e < -149) e = -149;
  const [a, b] = scaled(e);
  let m = a / b;
  const twice = (a - m * b) * 2n;
  if (twice > b || (twice === b && (m & 1n) === 1n)) m++;
  const out = Number(m) * 2 ** e;
  return out >= 2 ** 128 ? Infinity : out;
}

/** The text of a %f, as MSVC's parse_floating_point reads it into a float. */
export function parseFloat32(text: string): number {
  const t = text.toLowerCase();
  const negative = t[0] === "-";
  const body = t[0] === "-" || t[0] === "+" ? t.slice(1) : t;
  let out: number;
  if (body.startsWith("inf")) out = Infinity;
  else if (body.startsWith("nan")) out = NaN;
  else if (body.startsWith("0x")) {
    const m = /^0x([0-9a-f]*)\.?([0-9a-f]*)(?:p([+-]?\d+))?$/.exec(body)!;
    const exp = Number(m[3] ?? 0) - 4 * m[2]!.length;
    const digits = BigInt(`0x${m[1]}${m[2]}` === "0x" ? "0" : `0x${m[1]}${m[2]}`);
    if (digits === 0n) out = 0;
    else if (exp > 400) out = Infinity;
    else if (exp < -2000) out = 0;
    else out = exp >= 0 ? ratioToFloat32(digits << BigInt(exp), 1n) : ratioToFloat32(digits, 1n << BigInt(-exp));
  } else {
    const m = /^(\d*)\.?(\d*)(?:e([+-]?\d+))?$/.exec(body)!;
    const exp = Number(m[3] ?? 0) - m[2]!.length;
    const digits = BigInt((m[1]! + m[2]!) || "0");
    // Past these the answer is decided by the magnitude alone; BigInt need not try.
    const magnitude = digits.toString().length + exp;
    if (digits === 0n) out = 0;
    else if (magnitude > 45) out = Infinity;
    else if (magnitude < -50) out = 0;
    else out = exp >= 0 ? ratioToFloat32(digits * 10n ** BigInt(exp), 1n) : ratioToFloat32(digits, 10n ** BigInt(-exp));
  }
  return negative ? -out : out;
}

/**
 * sscanf_s for the directives share code uses: %d %u %x %f %Ns %n, literals, and
 * whitespace (which matches any amount, including none: "slot5 7" reads as "slot 5 7").
 */
export function sscanf(input: string, format: string): Scan {
  // A C string stops at its first NUL.
  const nul = input.indexOf("\0");
  const s = nul < 0 ? input : input.slice(0, nul);
  const values: (number | string)[] = [];
  let count = 0;
  let i = 0;
  const fail = (): Scan => ({ count: count === 0 && i >= s.length ? -1 : count, values, pos: i });
  for (let f = 0; f < format.length; f++) {
    const c = format[f]!;
    if (isSpace(c)) {
      while (isSpace(s[i])) i++;
      continue;
    }
    if (c !== "%") {
      if (s[i] !== c) return fail();
      i++;
      continue;
    }
    f++;
    let width = 0;
    while (format[f]! >= "0" && format[f]! <= "9") width = width * 10 + Number(format[f++]);
    const conv = format[f];
    if (conv === "n") {
      values.push(i);
      continue;
    }
    while (isSpace(s[i])) i++;
    if (i >= s.length) return fail();
    if (conv === "s") {
      const from = i;
      while (i < s.length && !isSpace(s[i]) && (!width || i - from < width)) i++;
      values.push(s.slice(from, i));
      count++;
    } else if (conv === "f") {
      const rest = s.slice(i);
      const m = FLOAT.exec(rest);
      if (!m || BROKEN_EXPONENT.test(rest.replace(/^[+-]/, ""))) return fail();
      values.push(parseFloat32(m[0]));
      i += m[0].length;
      count++;
    } else {
      const r = scanInteger(s, i, conv === "x" ? 16 : 10, conv === "d");
      if (!r) return fail();
      const low = r.value & MASK32;
      values.push(conv === "d" ? Number(BigInt.asIntN(32, low)) : Number(low));
      i = r.end;
      count++;
    }
  }
  return { count, values, pos: i };
}

const view = new DataView(new ArrayBuffer(8));

/**
 * printf("%.{digits}f") of a double, from its exact value, rounding an exact tie to
 * even. Floats reach printf as doubles, so a float32 passes through unchanged.
 */
export function fixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const negative = hi >>> 31 === 1;
  if (!Number.isFinite(x)) return negative ? "-inf" : "inf";
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  if (biased) mant |= 1n << 52n;
  const exp = (biased || 1) - 1075;
  const scale = 10n ** BigInt(digits);
  let scaled: bigint;
  if (exp >= 0) scaled = (mant << BigInt(exp)) * scale;
  else {
    const n = mant * scale;
    const shift = BigInt(-exp);
    scaled = n >> shift;
    const rest = n - (scaled << shift);
    const half = 1n << (shift - 1n);
    if (rest > half || (rest === half && (scaled & 1n) === 1n)) scaled++;
  }
  const text = scaled.toString().padStart(digits + 1, "0");
  const whole = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return negative ? `-${whole}` : whole;
}
