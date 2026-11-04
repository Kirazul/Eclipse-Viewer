/**
 * The port against the fixture the real C++ wrote (golden/). These run everywhere; the
 * ones that need the compiled harness are in native.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASSIC_FALLBACK } from "./bridge";
import { base64Decode, base64Encode, decode, encode, looksLikeCode } from "./code";
import { fixed, parseFloat32, sscanf } from "./cstdio";
import { dump } from "./dump";
import { deserialize, newOutfit, serialize, writeBack } from "./outfit";

const here = new URL("./golden/", import.meta.url);
const codes = readFileSync(new URL("codes.txt", here), "utf8").trim().split("\n");
const golden = JSON.parse(readFileSync(new URL("fields.json", here), "utf8")) as { name: string; code: string; text: string; again: string; fields: unknown }[];

describe("the golden codes, written by the real mo::Serialize", () => {
  it("there are enough of them, and the plain list is the same list", () => {
    expect(golden.length).toBeGreaterThanOrEqual(20);
    expect(codes).toEqual(golden.map((g) => g.code));
  });

  for (const g of golden) {
    describe(g.name, () => {
      it("decodes to the fields the real Deserialize read", () => {
        const o = decode(g.code);
        expect(o).not.toBeNull();
        expect(dump(o!)).toEqual(g.fields);
      });
      it("encodes back to the identical string, loaded and untouched", () => {
        expect(encode(decode(g.code)!)).toBe(g.code);
      });
      it("is rebuilt from its fields alone to what the real Serialize writes", () => {
        const o = decode(g.code)!;
        delete o.source;
        expect(encode(o)).toBe(g.again);
      });
      it("is what Serialize wrote, and Serialize writes it again", () => {
        expect(base64Decode(g.code.slice(5))).toBe(g.text);
        expect(`ECA1:${base64Encode(serialize(deserialize(g.text)))}`).toBe(g.again);
      });
      it("lights Import up", () => {
        expect(looksLikeCode(g.code)).toBe(true);
      });
    });
  }
});

describe("the codes the DLL wrote before the classic fallback, frozen", () => {
  // Never regenerated: old-format.json is what the old writer wrote, as players hold it.
  const old = JSON.parse(readFileSync(new URL("old-format.json", here), "utf8")) as typeof golden;
  it("all of them, and still rlook alone or look alone", () => {
    expect(old.length).toBe(38);
    for (const g of old) expect(/(^|\n)look .*\n(.*\n)*rlook /.test(g.text), g.name).toBe(false);
  });
  for (const g of old) {
    it(`${g.name}: read the same, and back byte for byte`, () => {
      expect(dump(decode(g.code)!)).toEqual(g.fields);
      expect(encode(decode(g.code)!)).toBe(g.code);
    });
    it(`${g.name}: an old string with a ~ section reads the same`, () => {
      const with_ = `${g.code}~labels~iVBORw0KGgo=`;
      expect(dump(decode(with_)!)).toEqual(g.fields);
      expect(encode(decode(with_)!)).toBe(with_);
    });
  }
});

describe("the fallback table", () => {
  it("is the one races::ClassicFallback compiled to", () => {
    const compiled = JSON.parse(readFileSync(new URL("fallback.json", here), "utf8")) as Record<string, number>;
    expect(CLASSIC_FALLBACK).toEqual(compiled);
  });
});

describe("Share.cpp's paste rules", () => {
  const code = codes[0]!;
  it("a tag in any case, surrounding space, a wrapped paste", () => {
    expect(dump(decode(code.replace("ECA1:", "eca1:"))!)).toEqual(dump(decode(code)!));
    expect(dump(decode(`  \n${code}\r\n `)!)).toEqual(dump(decode(code)!));
    expect(dump(decode(`${code.slice(0, 9)}\n${code.slice(9)}`)!)).toEqual(dump(decode(code)!));
  });
  it("no tag at all still decodes, as Decode allows it", () => {
    expect(dump(decode(code.slice(5))!)).toEqual(dump(decode(code)!));
    expect(looksLikeCode(code.slice(5))).toBe(false);
  });
  it("old-style codes: the first ~ ends the outfit, and the rest goes back untouched", () => {
    const old = `${code}~labels here~iVBORw0KGgo=`;
    expect(dump(decode(old)!)).toEqual(dump(decode(code)!));
    expect(encode(decode(old)!)).toBe(old);
  });
  it("what is not a code", () => {
    for (const bad of ["", "   ", "ECA1:", "ECA1: \n ", "ECA1:~picture", "ECA1:!!!!", "hello world!", "RHP1:abc$"]) expect(decode(bad)).toBeNull();
    for (const no of ["", null, undefined, "ECA", "RHP1:abc", "x ECA1:abc"]) expect(looksLikeCode(no)).toBe(false);
    expect(looksLikeCode("\n\t eca1:")).toBe(true);
  });
  it("an empty outfit is the bare tag, and the bare tag decodes to nothing", () => {
    expect(encode(newOutfit())).toBe("ECA1:");
    expect(decode("ECA1:")).toBeNull();
  });
});

describe("what the site cannot read goes back where it was", () => {
  const code = (text: string) => `ECA1:${base64Encode(text)}`;
  const newer = "slot 0 7\nfuturekey 1 2 3\nmount 9\nanother future line\n";

  it("an unknown key from a newer build survives, in place", () => {
    const c = code(newer);
    const o = decode(c)!;
    expect(o.extra.map((e) => e.line)).toEqual(["futurekey 1 2 3", "another future line"]);
    expect(encode(o)).toBe(c);
    delete o.source;
    expect(encode(o)).toBe(c);
  });
  it("and through an edit: only what was edited moves", () => {
    const o = decode(code(newer))!;
    o.item[0] = 8;
    expect(base64Decode(encode(o).slice(5))).toBe("slot 0 8\nfuturekey 1 2 3\nmount 9\nanother future line\n");
    o.mount = 0;
    expect(base64Decode(encode(o).slice(5))).toBe("slot 0 8\nfuturekey 1 2 3\nanother future line\n");
  });
  it("a look from a newer build, a preset this one lacks: kept, not worn", () => {
    const line = "skin 3 900 9999 0 0 128 128 128 128 128 128 0 0 0 255 128 0 255 255 255";
    const o = deserialize(`${line}\n`);
    expect(o.skin[3]!.item).toBe(0);
    expect(serialize(o)).toBe("");
    expect(writeBack(o)).toBe(`${line}\n`);
  });
  it("comments and blank lines in a hand-edited file survive while nothing is edited", () => {
    const c = code("# mine\n\nslot 0 7\n");
    const o = decode(c)!;
    expect(encode(o)).toBe(c);
    o.item[0] = 8;
    expect(base64Decode(encode(o).slice(5))).toBe("slot 0 8\n");
  });
  it("a retail body's whole line survives, however long", () => {
    const line = `rlook dracthyr m${Array.from({ length: 45 }, (_, i) => ` ${1000 + i}:${20000 + i}`).join("")}`;
    expect(line.length).toBeGreaterThan(320);
    const c = code(`${line}\n`);
    expect(decode(c)!.rlookKept).toBe(line);
    expect(encode(decode(c)!)).toBe(c);
  });
  it("a portable id with the client-own tag stays as it was", () => {
    const c = code("mount 1073741924\n");
    expect(decode(c)!.mount).toBe(1073741924);
    expect(encode(decode(c)!)).toBe(c);
  });
});

describe("the C library", () => {
  it("%.Nf rounds an exact tie to even, from the exact value", () => {
    expect(fixed(0.03125, 4)).toBe("0.0312");
    expect(fixed(0.09375, 4)).toBe("0.0938");
    expect(fixed(0.0625, 3)).toBe("0.062");
    expect(fixed(Math.fround(1.1), 4)).toBe("1.1000");
    expect(fixed(-0, 4)).toBe("-0.0000");
    expect(fixed(-0.00001, 3)).toBe("-0.000");
    expect(fixed(123456.703125, 4)).toBe("123456.7031");
    expect(fixed(Infinity, 3)).toBe("inf");
    expect(fixed(-Infinity, 3)).toBe("-inf");
    expect(fixed(NaN, 3)).toBe("nan");
  });
  it("%f rounds once, to the nearest float", () => {
    expect(parseFloat32("1.1")).toBe(Math.fround(1.1));
    expect(parseFloat32("-0.5")).toBe(-0.5);
    expect(parseFloat32("1e50")).toBe(Infinity);
    expect(parseFloat32("1e-60")).toBe(0);
    expect(parseFloat32("0x10")).toBe(16);
    // Exactly half way between two floats in decimal: ties to even.
    expect(parseFloat32("16777217")).toBe(16777216);
    expect(parseFloat32("16777219")).toBe(16777220);
    // A hair above half way, which a double rounds down to half way first.
    expect(parseFloat32("16777217.0000000001")).toBe(16777218);
  });
  it("sscanf: whitespace is optional, %u takes a sign, %x a prefix, numbers wrap", () => {
    expect(sscanf("slot5 7", "slot %d %u").values).toEqual([5, 7]);
    expect(sscanf("slot 0 -1", "slot %d %u").values).toEqual([0, 4294967295]);
    expect(sscanf("x 0xFF", "x %x").values).toEqual([255]);
    expect(sscanf("x 99999999999", "x %u").values).toEqual([1215752191]);
    expect(sscanf("slot", "slot %d").count).toBe(-1);
    expect(sscanf("nope", "slot %d").count).toBe(0);
  });
});
