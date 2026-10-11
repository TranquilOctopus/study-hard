// Reader for Anki .apkg / .colpkg packages: legacy (collection.anki2 /
// .anki21 with JSON metadata) and current (zstd-compressed
// collection.anki21b, schema 18 with protobuf configs and media index).

import { unzipSync } from "fflate";
import { decompress } from "fzstd";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";
import type { ImportBundle, ImportedCard, Note, Notetype, Schedule, Template } from "../model";
import { decodeMessage, getMessages, getString, getVarint } from "./protobuf";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const PACKAGE_VERSION_LATEST = 3;
const DAY_MS = 86_400_000;

function maybeZstd(data: Uint8Array): Uint8Array {
  return ZSTD_MAGIC.every((b, i) => data[i] === b) ? decompress(data) : data;
}

type Row = Record<string, SqlValue>;

function rows(db: Database, sql: string): Row[] {
  const [res] = db.exec(sql);
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

function readMedia(files: Record<string, Uint8Array>, version: number): Map<string, Uint8Array> {
  const media = new Map<string, Uint8Array>();
  const index = files["media"];
  if (!index) return media;
  if (version >= PACKAGE_VERSION_LATEST) {
    const entries = getMessages(decodeMessage(maybeZstd(index)), 1);
    entries.forEach((entry, i) => {
      const legacyName = entry.get(255) ? getVarint(entry, 255) : i;
      const data = files[String(legacyName)];
      if (data) media.set(getString(entry, 1), maybeZstd(data));
    });
  } else {
    const map = JSON.parse(new TextDecoder().decode(index)) as Record<string, string>;
    for (const [zipName, name] of Object.entries(map)) {
      if (files[zipName]) media.set(name, files[zipName]);
    }
  }
  return media;
}

function readNotetypesV18(db: Database): Notetype[] {
  const fields = new Map<string, string[]>();
  for (const r of rows(db, "SELECT ntid, name FROM fields ORDER BY ntid, ord")) {
    const id = String(r.ntid);
    fields.set(id, [...(fields.get(id) ?? []), String(r.name)]);
  }
  const templates = new Map<string, Template[]>();
  for (const r of rows(db, "SELECT ntid, name, config FROM templates ORDER BY ntid, ord")) {
    const id = String(r.ntid);
    const cfg = decodeMessage(r.config as Uint8Array);
    const t = { name: String(r.name), qfmt: getString(cfg, 1), afmt: getString(cfg, 2) };
    templates.set(id, [...(templates.get(id) ?? []), t]);
  }
  return rows(db, "SELECT id, name, config FROM notetypes").map((r) => {
    const id = String(r.id);
    const cfg = decodeMessage(r.config as Uint8Array);
    return {
      id,
      name: String(r.name),
      kind: getVarint(cfg, 1) === 1 ? "cloze" : "normal",
      css: getString(cfg, 3),
      fields: fields.get(id) ?? [],
      templates: templates.get(id) ?? [],
    };
  });
}

interface LegacyModel {
  id: number | string;
  name: string;
  type: number;
  css: string;
  flds: { name: string; ord: number }[];
  tmpls: { name: string; ord: number; qfmt: string; afmt: string }[];
}

function readNotetypesLegacy(col: Row): Notetype[] {
  const models = JSON.parse(String(col.models)) as Record<string, LegacyModel>;
  return Object.values(models).map((m) => ({
    id: String(m.id),
    name: m.name,
    kind: m.type === 1 ? "cloze" : "normal",
    css: m.css ?? "",
    fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
    templates: [...m.tmpls]
      .sort((a, b) => a.ord - b.ord)
      .map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
  }));
}

function readDecks(db: Database, col: Row, v18: boolean): Map<string, string> {
  if (v18) {
    return new Map(
      rows(db, "SELECT id, name FROM decks").map((r) => [String(r.id), String(r.name).split("\x1f").join("::")]),
    );
  }
  const decks = JSON.parse(String(col.decks)) as Record<string, { id: number; name: string }>;
  return new Map(Object.values(decks).map((d) => [String(d.id), d.name]));
}

/** Converts Anki SM-2 / FSRS card state into an FSRS schedule. */
export function convertSchedule(r: Row, crtSecs: number): Schedule | undefined {
  const type = Number(r.type);
  if (type !== 2 && type !== 3) return undefined;
  const due = Number(r.due);
  const ivl = Math.max(1, Number(r.ivl));
  // Learning-queue cards store a unix timestamp; review cards a day number.
  const dueMs = due > 1_000_000_000 ? due * 1000 : crtSecs * 1000 + due * DAY_MS;
  let memory: { s?: number; d?: number } = {};
  try {
    memory = JSON.parse(String(r.data || "{}"));
  } catch {
    // Older Anki versions stored non-JSON data here; ignore it.
  }
  const factor = Number(r.factor) || 2500;
  const difficulty = memory.d ?? Math.min(10, Math.max(1, 5 + (2500 - factor) / 240));
  return {
    due: dueMs,
    stability: memory.s ?? ivl,
    difficulty,
    elapsedDays: 0,
    scheduledDays: ivl,
    learningSteps: 0,
    reps: Number(r.reps),
    lapses: Number(r.lapses),
    state: 2,
    lastReview: dueMs - ivl * DAY_MS,
  };
}

export function readAnkiPackage(data: Uint8Array, SQL: SqlJsStatic): ImportBundle {
  const files = unzipSync(data);
  const meta = files["meta"] ? decodeMessage(files["meta"]) : undefined;
  const version = meta ? getVarint(meta, 1) : 1;

  const colFile = files["collection.anki21b"] ?? files["collection.anki21"] ?? files["collection.anki2"];
  if (!colFile) throw new Error("Not an Anki package: no collection file found");

  const db = new SQL.Database(maybeZstd(colFile));
  try {
    const v18 = rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='notetypes'").length > 0;
    const [col] = rows(db, v18 ? "SELECT crt FROM col" : "SELECT crt, models, decks FROM col");
    const notetypes = v18 ? readNotetypesV18(db) : readNotetypesLegacy(col);
    const decks = readDecks(db, col, v18);
    const known = new Set(notetypes.map((n) => n.id));

    const guidById = new Map<string, string>();
    const notes: Note[] = [];
    for (const r of rows(db, "SELECT id, guid, mid, tags, flds FROM notes ORDER BY id")) {
      if (!known.has(String(r.mid))) continue;
      guidById.set(String(r.id), String(r.guid));
      notes.push({
        guid: String(r.guid),
        notetypeId: String(r.mid),
        fields: String(r.flds).split("\x1f"),
        tags: String(r.tags).trim().split(/\s+/).filter(Boolean),
      });
    }

    const crt = Number(col.crt);
    const cards: ImportedCard[] = [];
    const sql = "SELECT nid, did, odid, ord, type, queue, due, ivl, factor, reps, lapses, data FROM cards ORDER BY nid, ord";
    for (const r of rows(db, sql)) {
      const guid = guidById.get(String(r.nid));
      if (!guid) continue;
      // Cards in a filtered deck remember their home deck in odid.
      const did = Number(r.odid) ? String(r.odid) : String(r.did);
      cards.push({
        noteGuid: guid,
        ord: Number(r.ord),
        deck: decks.get(did) ?? "Default",
        position: Number(r.type) === 0 ? Number(r.due) : 0,
        suspended: Number(r.queue) === -1,
        sched: convertSchedule(r, crt),
      });
    }
    return { notetypes, notes, cards, media: readMedia(files, version) };
  } finally {
    db.close();
  }
}
