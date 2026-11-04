// The real Races.cpp, compiled unedited, plus one door into its private state:
// the harness can then read a race manifest without a client, which is what
// `raceeclipse.mpq` being installed means to mo::Deserialize. Everything rlook
// does after that door is the file's own code.
#include "Races.cpp"

namespace wow {
namespace ec {
namespace races {

bool HarnessPack(const std::string& manifest) {
    std::vector<uint8_t> blob(manifest.begin(), manifest.end());
    if (!ParseManifest(blob)) return false;
    uint32_t next = 64;
    for (Race& r : g_race) r.local = next++;
    g_manifest = true;
    g_racesPlanned = true;
    g_displaysPlanned = true;
    g_spliced = true;
    return true;
}

// The fallback table as compiled, for the test that holds it equal to the website's.
std::string HarnessFallback() {
    std::string out = "{";
    for (const auto& f : kClassicFallback) {
        if (out.size() > 1) out += ",";
        out += "\"";
        out += f.key;
        out += "\":";
        out += std::to_string(f.race);
    }
    return out + "}";
}

}  // namespace races
}  // namespace ec
}  // namespace wow
