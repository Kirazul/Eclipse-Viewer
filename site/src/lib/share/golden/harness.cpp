// ===========================================================================
//  harness.cpp - the REAL share code, driven from the command line
// ===========================================================================
//  mo::Serialize, mo::Deserialize, share::Encode, share::Decode and
//  share::LooksLikeCode are Eclipse's own, linked from its sources unedited
//  (build.py). This file only builds outfits and prints what they do.
//
//      share_harness gen                     golden codes as JSON lines
//      share_harness check <file>            one code a line: does the DLL take it?
//      share_harness texts <file>            one hex text a line: Deserialize + Serialize
//      share_harness pastes <file>           one hex paste a line: LooksLikeCode + Decode
//      share_harness info                    the constants the port must agree with
//      share_harness fallback                races::ClassicFallback's table, as compiled
//      share_harness stale                   what is left of a kept line after choosing a look
//      --pack <manifest>  (first argument)   as if raceeclipse.mpq were installed
//
//  Share.h promises a RoundTrips() "field by field"; the current Share.cpp has
//  none. Dump() below IS that comparison: it prints every field of an Outfit,
//  floats as their bits, so two outfits are the same when their dumps are.
// ===========================================================================
#include "ObfStr.h"
#include "Eclipse.h"
#include "Share.h"
#include "SkinCatalog.h"
#include "SkinLines.h"

#include <stdio.h>
#include <string.h>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

using namespace wow;
using namespace wow::ec;

namespace wow { namespace ec { namespace races {
bool HarnessPack(const std::string& manifest);
std::string HarnessFallback();
} } }
namespace wow { namespace ec { namespace mo { void HarnessEnterChair(); } } }

namespace {

uint32_t Bits(float f) {
    uint32_t u;
    memcpy(&u, &f, 4);
    return u;
}

std::string JsonString(const std::string& s) {
    std::string out = "\"";
    char b[8];
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += (char)c; }
        else if (c < 0x20 || c >= 0x7F) { _snprintf_s(b, sizeof b, _TRUNCATE, "\\u%04x", c); out += b; }
        else out += (char)c;
    }
    return out + "\"";
}

struct J {
    std::string s;
    void Num(const char* key, uint64_t v) { Key(key); s += std::to_string(v); }
    void Bool(const char* key, bool v) { Key(key); s += v ? "true" : "false"; }
    void Raw(const char* key, const std::string& v) { Key(key); s += v; }
    void Key(const char* key) {
        if (!s.empty()) s += ',';
        s += '"'; s += key; s += "\":";
    }
};

std::string Row(std::initializer_list<uint64_t> v) {
    std::string s = "[";
    bool first = true;
    for (uint64_t x : v) {
        if (!first) s += ',';
        first = false;
        s += std::to_string(x);
    }
    return s + "]";
}

std::string SkinRow(int i, const skins::Look& l) {
    return Row({(uint64_t)i, l.item, l.preset, l.palette, l.placement, l.strength, l.speed, l.scale, l.rim,
                l.sparkle, l.depth, l.seed, l.dir, l.color.hue, l.color.sat, l.color.light, l.color.dye,
                l.accent[0], l.accent[1], l.accent[2]});
}

// Every field, in the struct's order. Lists hold only what is on.
std::string Dump(const mo::Outfit& o) {
    J j;
    std::string list = "[";
    for (int i = 0; i < morph::kSlotCount; ++i)
        if (o.managed[i] || o.item[i]) {
            if (list.size() > 1) list += ',';
            list += Row({(uint64_t)i, o.item[i], o.managed[i] ? 1u : 0u});
        }
    j.Raw("slots", list + "]");
    j.Num("display", o.display);
    j.Bool("displayNative", o.displayNative);
    j.Num("mount", o.mount);
    j.Bool("mountHidden", o.mountHidden);
    j.Num("mountFly", o.mountFly);
    j.Num("scale", Bits(o.scale));
    j.Raw("sheathe", Row({o.sheathe[0], o.sheathe[1]}));
    j.Raw("enchant", "[" + Row({o.enchant[0].id, o.enchant[0].colour, o.enchant[0].managed ? 1u : 0u, o.enchant[0].tint ? 1u : 0u}) + "," +
                     Row({o.enchant[1].id, o.enchant[1].colour, o.enchant[1].managed ? 1u : 0u, o.enchant[1].tint ? 1u : 0u}) + "]");
    j.Bool("glowKnown", o.glowKnown);
    j.Raw("look", Row({o.look.managed ? 1u : 0u, o.look.race, o.look.gender, o.look.skin, o.look.face,
                       o.look.hairStyle, o.look.hairColour, o.look.facialHair}));
    j.Raw("rlookKept", JsonString(o.rlookKept));
    list = "[";
    for (int a = 0; a < ccol::kAxisCount; ++a)
        if (o.colors.on[a] || o.colors.rgb[a]) {
            if (list.size() > 1) list += ',';
            list += Row({(uint64_t)a, o.colors.rgb[a], o.colors.on[a] ? 1u : 0u});
        }
    j.Raw("colors", list + "]");
    j.Bool("colorsKnown", o.colorsKnown);
    list = "[";
    for (int w = 0; w < wcol::kSlotCount; ++w)
        if (o.wtint[w].On()) {
            if (list.size() > 1) list += ',';
            const wcol::Tint& t = o.wtint[w];
            list += Row({(uint64_t)w, t.item, t.look.hue, t.look.sat, t.look.light, t.look.dye});
        }
    j.Raw("wtint", list + "]");
    j.Bool("wtintKnown", o.wtintKnown);
    j.Bool("gtintKnown", o.gtintKnown);
    list = "[";
    for (int k = 0; k < skins::kSlots; ++k)
        if (o.skin[k].On()) {
            if (list.size() > 1) list += ',';
            list += SkinRow(k, o.skin[k]);
        }
    j.Raw("skin", list + "]");
    j.Bool("skinOn", o.skinOn);
    j.Bool("skinKnown", o.skinKnown);
    list = "[";
    for (int m = 0; m < wcol::kMountSlots; ++m)
        if (o.mskin[m].On()) {
            if (list.size() > 1) list += ',';
            list += SkinRow(m, o.mskin[m]);
        }
    j.Raw("mskin", list + "]");
    j.Bool("mskinKnown", o.mskinKnown);
    list = "[";
    for (int m = 0; m < wcol::kMountSlots; ++m)
        if (o.mtint[m].On()) {
            if (list.size() > 1) list += ',';
            const wcol::Tint& t = o.mtint[m];
            list += Row({(uint64_t)m, t.item, t.look.hue, t.look.sat, t.look.light, t.look.dye});
        }
    j.Raw("mtint", list + "]");
    j.Bool("mtintKnown", o.mtintKnown);
    list = "[";
    for (int i = 0; i < o.cosmeticCount; ++i) {
        if (list.size() > 1) list += ',';
        const mo::Outfit::CosmeticLook& c = o.cosmetic[i];
        list += Row({c.target, c.catalog ? 1u : 0u, Bits(c.scale), Bits(c.offset[0]), Bits(c.offset[1]), Bits(c.offset[2]),
                     Bits(c.turn[0]), Bits(c.turn[1]), Bits(c.turn[2]), c.coloured ? 1u : 0u, c.colour.mode, Bits(c.colour.hue),
                     Bits(c.colour.saturation), Bits(c.colour.intensity), Bits(c.colour.whiteCore), Bits(c.colour.windowHue),
                     Bits(c.colour.window), Bits(c.colour.feather), c.scope});
    }
    j.Raw("cosmetics", list + "]");
    j.Bool("cosmeticsKnown", o.cosmeticsKnown);
    return "{" + j.s + "}";
}

std::string Hex(const std::string& s) {
    std::string out;
    char b[4];
    for (unsigned char c : s) { _snprintf_s(b, sizeof b, _TRUNCATE, "%02x", c); out += b; }
    return out;
}

std::string Unhex(const std::string& h) {
    std::string out;
    for (size_t i = 0; i + 1 < h.size(); i += 2) {
        char b[3] = {h[i], h[i + 1], 0};
        out += (char)strtoul(b, nullptr, 16);
    }
    return out;
}

// --- the golden outfits ----------------------------------------------------
using morph::kSlotHead;
using morph::kSlotShoulder;
using morph::kSlotShirt;
using morph::kSlotChest;
using morph::kSlotWaist;
using morph::kSlotLegs;
using morph::kSlotFeet;
using morph::kSlotWrist;
using morph::kSlotHands;
using morph::kSlotBack;
using morph::kSlotMainHand;
using morph::kSlotOffHand;
using morph::kSlotRanged;
using morph::kSlotTabard;

void Wear(mo::Outfit& o, int s, uint32_t item) { o.managed[s] = true; o.item[s] = item; }

void Tint(wcol::Tint& t, uint32_t item, uint16_t hue, uint8_t sat, uint8_t light, uint8_t dye) {
    t.item = item; t.look.hue = hue; t.look.sat = sat; t.look.light = light; t.look.dye = dye;
}

skins::Look Skin(uint32_t item, uint16_t preset) {
    skins::Look l;
    l.item = item; l.preset = preset;
    l.palette = skins::kPaletteRecolor; l.placement = skins::kBright;
    l.strength = 200; l.speed = 90; l.scale = 64; l.rim = 255; l.sparkle = 0; l.depth = 12;
    l.seed = 7; l.dir = 33;
    l.color.hue = 1234; l.color.sat = 200; l.color.light = 100; l.color.dye = 50;
    l.accent[0] = 10; l.accent[1] = 20; l.accent[2] = 30;
    return l;
}

void Cosmetic(mo::Outfit& o, uint32_t target, bool catalog, float scale, float x, float y, float z, float a, float b, float c,
              bool coloured, uint8_t mode, float hue, uint8_t scope) {
    mo::Outfit::CosmeticLook& k = o.cosmetic[o.cosmeticCount++];
    k.target = target; k.catalog = catalog; k.scale = scale;
    k.offset[0] = x; k.offset[1] = y; k.offset[2] = z;
    k.turn[0] = a; k.turn[1] = b; k.turn[2] = c;
    k.coloured = coloured; k.colour.mode = mode; k.colour.hue = hue; k.scope = scope;
    o.cosmeticsKnown = true;
}

struct Golden { const char* name; mo::Outfit o; };

std::vector<Golden> Build() {
    std::vector<Golden> g;
    auto add = [&](const char* name) -> mo::Outfit& { g.push_back({name, mo::Outfit()}); return g.back().o; };

    { auto& o = add("one piece"); Wear(o, kSlotHead, 231001); }
    { auto& o = add("the whole ring");
      int s[] = {kSlotHead, kSlotShoulder, kSlotBack, kSlotChest, kSlotShirt, kSlotTabard, kSlotWrist, kSlotHands,
                 kSlotWaist, kSlotLegs, kSlotFeet, kSlotMainHand, kSlotOffHand, kSlotRanged};
      for (int i = 0; i < 14; ++i) Wear(o, s[i], 800000u + i * 37u); }
    { auto& o = add("slots shown as nothing"); Wear(o, kSlotChest, 19019); Wear(o, kSlotShirt, mo::kHidden); Wear(o, kSlotTabard, mo::kHidden); }
    { auto& o = add("neck, rings and trinkets"); Wear(o, morph::kSlotNeck, 1); Wear(o, morph::kSlotFinger1, 2); Wear(o, morph::kSlotFinger2, 3);
      Wear(o, morph::kSlotTrinket1, 4); Wear(o, morph::kSlotTrinket2, 4294967295u); }
    { auto& o = add("creature morph"); o.display = 28213; }
    { auto& o = add("old native morph flag"); o.display = 4294967295u >> 8; o.displayNative = true; }
    { auto& o = add("ground mount"); o.mount = 25159; }
    { auto& o = add("two mounts"); o.mount = 25159; o.mountFly = 31992; }
    { auto& o = add("flying slot alone"); o.mountFly = 31992; }
    { auto& o = add("mount hidden"); o.mountHidden = true; }
    { auto& o = add("sheathe"); o.sheathe[0] = morph::kSheathePos_Hip; o.sheathe[1] = morph::kSheathePos_Hidden; }
    { auto& o = add("glow, untinted"); o.glowKnown = true; o.enchant[0].id = 3789; o.enchant[0].managed = true; }
    { auto& o = add("glow, tinted both hands"); o.glowKnown = true;
      o.enchant[0].id = 3789; o.enchant[0].managed = true; o.enchant[0].tint = true; o.enchant[0].colour = 0x00FF7F;
      o.enchant[1].id = 0; o.enchant[1].managed = true; o.enchant[1].tint = true; o.enchant[1].colour = 0x0A0B0C; }
    { auto& o = add("no glow is an answer"); o.glowKnown = true; }
    { auto& o = add("old look, glow without its flag"); o.enchant[1].id = 2673; }
    { auto& o = add("scale"); o.scale = 1.25f; }
    { auto& o = add("scale, a printf tie"); o.scale = 0.03125f; }
    { auto& o = add("scale, an inexact float"); o.scale = 1.1f; }
    { auto& o = add("scale, large"); o.scale = 123456.7f; }
    { auto& o = add("classic body"); o.look.managed = true; o.look.race = 4; o.look.gender = 1; o.look.skin = 3; o.look.face = 5; o.look.hairStyle = 2; o.look.hairColour = 7; o.look.facialHair = 1; }
    { auto& o = add("classic body, every byte high"); o.look.managed = true; o.look.race = 11; o.look.gender = 0; o.look.skin = 255; o.look.face = 254; o.look.hairStyle = 253; o.look.hairColour = 252; o.look.facialHair = 251; }
    { auto& o = add("retail body, kept"); lstrcpynA(o.rlookKept, "rlook pandaren f 1:2 73:845 74:1001 10:44", sizeof o.rlookKept); }
    { auto& o = add("classic fallback under a kept retail line"); Wear(o, kSlotHead, 231001); o.look.managed = true; o.look.race = 1; o.look.gender = 1; lstrcpynA(o.rlookKept, "rlook pandaren f 1:2 73:845 74:1001 10:44", sizeof o.rlookKept); }
    { auto& o = add("colours, none on"); o.colorsKnown = true; }
    { auto& o = add("colours, every axis"); o.colorsKnown = true;
      for (int a = 0; a < ccol::kAxisCount; ++a) { o.colors.on[a] = true; o.colors.rgb[a] = 0x102030u * (a + 1) & 0xFFFFFF; } }
    { auto& o = add("colour line implies known"); o.colors.on[1] = true; o.colors.rgb[1] = 0xABCDEF; }
    { auto& o = add("weapon colours"); Wear(o, kSlotMainHand, 49623); o.wtintKnown = true;
      Tint(o.wtint[wcol::kMain], 49623, 3599, 255, 128, 0); Tint(o.wtint[wcol::kOff], 50730, 1, 0, 255, 255); }
    { auto& o = add("gear colours"); Wear(o, kSlotChest, 51000); o.gtintKnown = true;
      Tint(o.wtint[wcol::kChest], 51000, 900, 180, 90, 12); Tint(o.wtint[wcol::kFeet], 51001, 1800, 40, 200, 77); }
    { auto& o = add("no colour flags, gear line"); Tint(o.wtint[wcol::kHead], 7, 450, 1, 2, 3); }
    { auto& o = add("skins"); o.skinKnown = true; o.skinOn = true; o.skin[wcol::kChest] = Skin(51000, 3); o.skin[skins::kBody] = Skin(1, 5); }
    { auto& o = add("skin flag alone"); o.skinKnown = true; }
    { auto& o = add("mount skin on any ride"); o.mskinKnown = true; o.mskin[0] = Skin(mo::kAnyRide, 2); }
    { auto& o = add("mount skin bound"); o.mount = 25159; o.mountFly = 31992; o.mskinKnown = true;
      o.mskin[0] = Skin(25159, 4); o.mskin[1] = Skin(31992, 6); }
    { auto& o = add("mount colour"); o.mount = 25159; o.mountFly = 31992; o.mtintKnown = true;
      Tint(o.mtint[0], 25159, 2100, 200, 128, 0); Tint(o.mtint[1], 31992, 300, 255, 40, 255); }
    { auto& o = add("mount colour with no such mount"); o.mount = 25159; o.mtintKnown = true; Tint(o.mtint[0], 11111, 2100, 200, 128, 0); }
    { auto& o = add("no cosmetics is an answer"); o.cosmeticsKnown = true; }
    { auto& o = add("cosmetics"); Cosmetic(o, 71111, false, 1.f, 0.f, 0.f, 0.f, 0.f, 0.f, 0.f, false, 0, 250.f, 0);
      Cosmetic(o, 4242, true, 0.0625f, -0.5f, 1.5f, 0.00005f, 359.5f, -180.f, 0.0625f, true, 1, 12.345f, 1); }
    { auto& o = add("sixteen cosmetics");
      for (int i = 0; i < 16; ++i) Cosmetic(o, 1000u + i, i & 1, 0.1f * (i + 1), 0.25f * i, -0.25f * i, 1.f / (i + 1), 1.5f * i, 0.f, 0.f, i % 3 == 0, (uint8_t)(i & 1), 3.5f * i, (uint8_t)((i >> 1) & 1)); }
    { auto& o = add("everything at once");
      Wear(o, kSlotHead, 11); Wear(o, kSlotShoulder, 22); Wear(o, kSlotChest, 33); Wear(o, kSlotShirt, mo::kHidden); Wear(o, kSlotMainHand, 44); Wear(o, kSlotOffHand, 55);
      o.display = 1234; o.mount = 25159; o.mountFly = 31992; o.mountHidden = true;
      o.sheathe[0] = 1; o.sheathe[1] = 2; o.glowKnown = true;
      o.enchant[0].id = 3789; o.enchant[0].managed = true; o.enchant[0].tint = true; o.enchant[0].colour = 0xFF00FF;
      o.scale = 0.9f;
      o.look.managed = true; o.look.race = 1; o.look.gender = 1; o.look.skin = 1; o.look.face = 2; o.look.hairStyle = 3; o.look.hairColour = 4; o.look.facialHair = 5;
      o.colorsKnown = true; o.colors.on[0] = true; o.colors.rgb[0] = 0x123456;
      o.wtintKnown = true; o.gtintKnown = true; Tint(o.wtint[wcol::kMain], 44, 100, 200, 128, 9); Tint(o.wtint[wcol::kChest], 33, 200, 100, 64, 8);
      o.skinKnown = true; o.skinOn = true; o.skin[wcol::kOff] = Skin(55, 1);
      o.mskinKnown = true; o.mskin[1] = Skin(31992, 2);
      o.mtintKnown = true; Tint(o.mtint[0], 25159, 3000, 128, 128, 128);
      Cosmetic(o, 9999, true, 2.f, 0.1f, 0.2f, 0.3f, 10.f, 20.f, 30.f, true, 1, 123.456f, 1); }
    return g;
}

std::vector<std::string> Lines(const char* path) {
    std::ifstream f(path, std::ios::binary);
    std::vector<std::string> out;
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        out.push_back(line);
    }
    return out;
}

void Emit(const std::string& s) { fwrite(s.data(), 1, s.size(), stdout); fputc('\n', stdout); fflush(stdout); }

// The live state's steps. Plain functions, because __try can't share a frame with
// objects to unwind, and a step that reaches client memory must fail by itself.
void report(const char* step, bool faulted = false) {
    J j;
    j.Raw("step", JsonString(step));
    j.Bool("faulted", faulted);
    j.Raw("text", JsonString(mo::Serialize(mo::Current())));
    Emit("{" + j.s + "}");
}
void WearBoth() {
    mo::Outfit o;
    mo::Deserialize("look 1 1 0 0 0 0 0\nrlook pandaren f 1:2\n", o);
    mo::ApplyLoadout(o);
}
void ChooseOther() {
    cc::Look other;
    other.managed = true;
    other.race = 4;
    mo::SetLook(other);
}
void TakeOff() { mo::SetLook(cc::Look()); }
void ApplyClassic() {
    mo::Outfit classic;
    mo::Deserialize("look 4 0 0 0 0 0 0\n", classic);
    mo::ApplyLoadout(classic);
}
void ResetAll() { mo::ClearAll(); }
void EnterChair() { mo::HarnessEnterChair(); }

bool Run(void (*step)()) {
    __try {
        step();
        return false;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return true;
    }
}
void Guarded(void (*step)(), const char* name) { report(name, Run(step)); }

}  // namespace

int main(int argc, char** argv) {
    int a = 1;
    if (a + 1 < argc && strcmp(argv[a], "--pack") == 0) {
        std::ifstream f(argv[a + 1], std::ios::binary);
        std::stringstream all;
        all << f.rdbuf();
        if (!races::HarnessPack(all.str())) { fprintf(stderr, "the manifest did not parse\n"); return 3; }
        a += 2;
    }
    const std::string mode = a < argc ? argv[a] : "";

    if (mode == "info") {
        J j;
        j.Num("slotCount", morph::kSlotCount);
        j.Num("colourSlots", wcol::kSlotCount);
        j.Num("skinSlots", skins::kSlots);
        j.Num("mountSlots", wcol::kMountSlots);
        j.Num("axes", ccol::kAxisCount);
        j.Num("presets", (uint64_t)skins::PresetCount());
        j.Num("palettes", skins::kPaletteCount);
        j.Num("placements", skins::kPlaceCount);
        j.Num("cosmeticModes", wow::ec::sclr::kMode_COUNT);
        j.Num("maxCosmetics", mo::Outfit::kMaxCosmetics);
        j.Num("sheathePositions", morph::kSheathePos_Count);
        j.Num("anyRide", mo::kAnyRide);
        j.Num("hidden", mo::kHidden);
        Emit("{" + j.s + "}");
        return 0;
    }
    if (mode == "fallback") {
        Emit(races::HarnessFallback());
        return 0;
    }
    // The live state's paths, through Morph's own functions: what is left of a kept
    // retail line after each way of choosing a look. Choosing a managed look reaches
    // client memory (LookPolicy, then Sanitise), so that step faults here and says so;
    // taking the look off goes through the same line with no client read.
    if (mode == "stale") {
        report("start");
        Guarded(WearBoth, "worn");
        Guarded(ChooseOther, "another look chosen");
        Guarded(WearBoth, "worn again");
        Guarded(TakeOff, "the look taken off");
        Guarded(WearBoth, "worn again");
        Guarded(ApplyClassic, "a classic loadout applied");
        Guarded(WearBoth, "worn again");
        Guarded(ResetAll, "reset everything");
        Guarded(WearBoth, "worn again");
        Guarded(EnterChair, "in the barber's chair");
        Guarded(TakeOff, "the look taken off in the chair");
        return 0;
    }
    if (mode == "gen") {
        for (const Golden& g : Build()) {
            const std::string code = share::Encode(g.o);
            mo::Outfit back;
            const bool ok = share::Decode(code, back);
            // `again` is what the DLL writes after reading it: the same code, except
            // where Deserialize normalizes (an old flag, a colour with no such mount).
            const std::string again = ok ? share::Encode(back) : "";
            mo::Outfit back2;
            const bool stable = ok && share::Decode(again, back2) && Dump(back) == Dump(back2) && share::Encode(back2) == again;
            J j;
            j.Raw("name", JsonString(g.name));
            j.Raw("code", JsonString(code));
            j.Raw("text", JsonString(mo::Serialize(g.o)));
            j.Bool("decodes", ok);
            j.Bool("roundtrips", stable);
            j.Raw("again", JsonString(again));
            j.Raw("fields", ok ? Dump(back) : "null");
            Emit("{" + j.s + "}");
        }
        return 0;
    }
    if (mode == "check" && a + 1 < argc) {
        for (const std::string& code : Lines(argv[a + 1])) {
            if (code.empty()) continue;
            mo::Outfit o, o2;
            const bool ok = share::Decode(code, o);
            const std::string again = ok ? share::Encode(o) : "";
            const bool ok2 = ok && share::Decode(again, o2);
            J j;
            j.Bool("looks", share::LooksLikeCode(code.c_str()));
            j.Bool("decodes", ok);
            j.Bool("identical", again == code);
            j.Bool("roundtrips", ok2 && Dump(o) == Dump(o2));
            j.Raw("again", JsonString(again));
            j.Raw("fields", ok ? Dump(o) : "null");
            Emit("{" + j.s + "}");
        }
        return 0;
    }
    if (mode == "texts" && a + 1 < argc) {
        for (const std::string& h : Lines(argv[a + 1])) {
            mo::Outfit o;
            const bool ok = mo::Deserialize(Unhex(h), o);
            J j;
            j.Bool("ok", ok);
            j.Raw("ser", JsonString(Hex(mo::Serialize(o))));
            j.Raw("fields", Dump(o));
            Emit("{" + j.s + "}");
        }
        return 0;
    }
    if (mode == "pastes" && a + 1 < argc) {
        for (const std::string& h : Lines(argv[a + 1])) {
            const std::string text = Unhex(h);
            mo::Outfit o;
            const bool ok = share::Decode(text, o);
            J j;
            j.Bool("looks", share::LooksLikeCode(text.c_str()));
            j.Bool("ok", ok);
            j.Raw("ser", JsonString(Hex(ok ? mo::Serialize(o) : std::string())));
            Emit("{" + j.s + "}");
        }
        return 0;
    }
    fprintf(stderr, "usage: share_harness [--pack manifest] gen | info | check <file> | texts <file> | pastes <file>\n");
    return 2;
}
