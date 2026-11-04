import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILD } from "@eclipse/format";
import { WORK, md5Hex } from "../lib/env";
import { httpGet } from "../sources/source";

export type Row = Record<string, string>;

/**
 * Columns kept from the big tables. ItemSparse has over 150 columns across hundreds of
 * thousands of rows: as objects, all of it would not fit in a runner's heap.
 */
const KEEP: Record<string, readonly string[]> = {
  ItemSparse: ["ID", "Display_lang", "ExpansionID", "OverallQualityID"],
  Item: ["ID", "ClassID", "SubclassID", "InventoryType", "IconFileDataID", "SheatheType"],
  CreatureDisplayInfo: ["ID", "ModelID", "ExtendedDisplayInfoID", "CreatureModelScale", "TextureVariationFileDataID_0", "TextureVariationFileDataID_1", "TextureVariationFileDataID_2", "TextureVariationFileDataID_3"],
  CreatureModelData: ["ID", "FileDataID", "CreatureGeosetDataID", "ModelScale"],
  SpellMisc: ["ID", "SpellID", "SpellIconFileDataID"],
};

/** RFC 4180: quoted fields may hold commas, quotes (doubled) and newlines. Lore text does. */
export function parseCsv(text: string, keep?: readonly string[]): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const head = rows.shift();
  if (!head) return [];
  const columns = head.map((h, k) => [h, k] as const).filter(([h]) => !keep || keep.includes(h));
  return rows.filter((r) => r.length > 1 || r[0] !== "").map((r) => {
    const o: Row = {};
    for (const [h, k] of columns) o[h] = r[k] ?? "";
    return o;
  });
}

export function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Rows grouped by a column. */
export function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r[key] ?? "";
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function byId(rows: Row[], key = "ID"): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows) m.set(r[key] ?? "", r);
  return m;
}

/**
 * A DB2 table at the pinned build, from wago, cached on disk.
 *
 * `where` answers one column = value. With a whole table on disk, or in `full` mode,
 * it searches that. In `query` mode it asks wago for just those rows, one small CSV
 * per question, which is how the item resolver runs on a slow line: ItemSparse alone
 * is tens of megabytes.
 */
export class Db2 {
  private readonly dir: string;
  private readonly memo = new Map<string, Row[]>();
  private readonly indexes = new Map<string, Map<string, Row[]>>();
  private readonly answers = new Map<string, Row[]>();
  /** MD5 of each table read: tables are inputs like any other. */
  readonly hashes = new Map<string, string>();

  constructor(
    private readonly build = BUILD.version,
    readonly mode: "full" | "query" = "full",
  ) {
    this.dir = join(WORK, "db2", build);
  }

  private hasWhole(name: string): boolean {
    return this.memo.has(name) || existsSync(join(this.dir, `${name}.csv`));
  }

  async where(name: string, column: string, value: string | number): Promise<Row[]> {
    const v = String(value);
    if (this.mode === "full" || this.hasWhole(name)) {
      const id = `${name}.${column}`;
      let index = this.indexes.get(id);
      if (!index) {
        index = groupBy(await this.table(name), column);
        this.indexes.set(id, index);
      }
      return index.get(v) ?? [];
    }
    const id = `${name}.${column}.${v}`;
    const hit = this.answers.get(id);
    if (hit) return hit;
    const p = join(this.dir, "q", `${id}.csv`);
    let body: Buffer;
    if (existsSync(p)) {
      body = readFileSync(p);
    } else {
      const url = `https://wago.tools/db2/${name}/csv?build=${this.build}&filter%5B${column}%5D=exact%3A${encodeURIComponent(v)}`;
      const got = await httpGet(url, { timeoutMs: 120_000 });
      if (!got) throw new Error(`wago has no table ${name} at ${this.build}`);
      body = got;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(`${p}.tmp`, body);
      renameSync(`${p}.tmp`, p);
    }
    const rows = parseCsv(body.toString("utf8"));
    this.answers.set(id, rows);
    return rows;
  }

  async table(name: string): Promise<Row[]> {
    const hit = this.memo.get(name);
    if (hit) return hit;
    const p = join(this.dir, `${name}.csv`);
    let body: Buffer;
    if (existsSync(p)) {
      body = readFileSync(p);
    } else {
      const got = await httpGet(`https://wago.tools/db2/${name}/csv?build=${this.build}`, { timeoutMs: 600_000 });
      if (!got) throw new Error(`wago has no table ${name} at ${this.build}`);
      body = got;
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(`${p}.tmp`, body);
      renameSync(`${p}.tmp`, p);
    }
    this.hashes.set(name, md5Hex(body));
    const rows = parseCsv(body.toString("utf8"), KEEP[name]);
    this.memo.set(name, rows);
    return rows;
  }
}
