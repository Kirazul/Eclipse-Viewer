/** An Outfit as the harness prints one (golden/harness.cpp Dump): for comparing the two. */
import type { Outfit, SkinLook } from "./outfit";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** The UCRT reads "nan" as 0x7FFFFFFF; JS has one NaN and no payload to tell them by. */
const bits = (f: number) => {
  if (Number.isNaN(f)) return 0x7fffffff;
  f32[0] = f;
  return u32[0]!;
};
const skinRow = (i: number, l: SkinLook) => [
  i, l.item, l.preset, l.palette, l.placement, l.strength, l.speed, l.scale, l.rim, l.sparkle, l.depth, l.seed, l.dir,
  l.color.hue, l.color.sat, l.color.light, l.color.dye, l.accent[0], l.accent[1], l.accent[2],
];
const flag = (b: boolean) => (b ? 1 : 0);

export function dump(o: Outfit) {
  return {
    slots: o.item.flatMap((item, i) => (o.managed[i] || item ? [[i, item, flag(o.managed[i]!)]] : [])),
    display: o.display,
    displayNative: o.displayNative,
    mount: o.mount,
    mountHidden: o.mountHidden,
    mountFly: o.mountFly,
    scale: bits(o.scale),
    sheathe: o.sheathe,
    enchant: o.enchant.map((e) => [e.id, e.colour, flag(e.managed), flag(e.tint)]),
    glowKnown: o.glowKnown,
    look: [flag(o.look.managed), o.look.race, o.look.gender, o.look.skin, o.look.face, o.look.hairStyle, o.look.hairColour, o.look.facialHair],
    rlookKept: o.rlookKept,
    colors: o.colors.rgb.flatMap((rgb, a) => (o.colors.on[a] || rgb ? [[a, rgb, flag(o.colors.on[a]!)]] : [])),
    colorsKnown: o.colorsKnown,
    wtint: o.wtint.flatMap((t, w) => (t.item ? [[w, t.item, t.look.hue, t.look.sat, t.look.light, t.look.dye]] : [])),
    wtintKnown: o.wtintKnown,
    gtintKnown: o.gtintKnown,
    skin: o.skin.flatMap((l, k) => (l.item ? [skinRow(k, l)] : [])),
    skinOn: o.skinOn,
    skinKnown: o.skinKnown,
    mskin: o.mskin.flatMap((l, m) => (l.item ? [skinRow(m, l)] : [])),
    mskinKnown: o.mskinKnown,
    mtint: o.mtint.flatMap((t, m) => (t.item ? [[m, t.item, t.look.hue, t.look.sat, t.look.light, t.look.dye]] : [])),
    mtintKnown: o.mtintKnown,
    cosmetics: o.cosmetic.map((c) => [
      c.target, flag(c.catalog), bits(c.scale), bits(c.offset[0]), bits(c.offset[1]), bits(c.offset[2]),
      bits(c.turn[0]), bits(c.turn[1]), bits(c.turn[2]), flag(c.coloured), c.colour.mode, bits(c.colour.hue),
      bits(c.colour.saturation), bits(c.colour.intensity), bits(c.colour.whiteCore), bits(c.colour.windowHue),
      bits(c.colour.window), bits(c.colour.feather), c.scope,
    ]),
    cosmeticsKnown: o.cosmeticsKnown,
  };
}
