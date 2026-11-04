// Writes the fixtures from the real C++: build.py first, then
//   node site/src/lib/share/golden/regen.mjs
// codes.txt is the plain code strings; fields.json is what the real Deserialize read
// out of each. Nothing here is hand-written, and nothing is rewritten by a test.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = resolve(here, "../../../../../work/share-harness/share_harness.exe");
const r = spawnSync(exe, ["gen"], { encoding: "latin1", maxBuffer: 1 << 26 });
if (r.status) throw new Error(r.stderr || `harness exited ${r.status}`);
const rows = r.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
for (const row of rows) if (!row.decodes || !row.roundtrips) throw new Error(`the DLL's own code failed its own trip: ${row.name}`);
writeFileSync(resolve(here, "codes.txt"), `${rows.map((x) => x.code).join("\n")}\n`);
writeFileSync(resolve(here, "fields.json"), `${JSON.stringify(rows.map(({ name, code, text, again, fields }) => ({ name, code, text, again, fields })), null, 0).replace(/\},\{"name"/g, '},\n{"name"')}\n`);
// The table as compiled, so the site's can be held to it on a machine with no C++.
const table = spawnSync(exe, ["fallback"], { encoding: "latin1" });
if (table.status) throw new Error(table.stderr || `harness exited ${table.status}`);
writeFileSync(resolve(here, "fallback.json"), `${table.stdout.trim()}\n`);
console.log(`${rows.length} golden codes`);
