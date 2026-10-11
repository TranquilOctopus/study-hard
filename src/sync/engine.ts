// Local-first sync: push the outbox, then pull rows changed on the server
// since the last pull. Conflicts resolve as last-write-wins, except that a
// local change that hasn't been pushed yet is never overwritten by a pull.

import type { MediaRecord } from "../model";
import { SYNC_TABLES, type StudyDB, type SyncTable } from "../db";
import { outboxKey } from "./tracking";

export interface RemoteRow {
  id: string;
  data: unknown;
  deleted: boolean;
  updated_at: string;
}

export type RowWrite = Omit<RemoteRow, "updated_at">;

/** The server side of sync; implemented over Supabase in remote.ts. */
export interface Remote {
  readonly userId: string;
  upsert(table: string, rows: RowWrite[]): Promise<void>;
  /** Rows with updated_at > since, ordered by (updated_at, id). */
  changes(table: string, since: string | undefined, offset: number, limit: number): Promise<RemoteRow[]>;
  uploadMedia(path: string, data: Blob): Promise<void>;
  downloadMedia(path: string): Promise<Blob>;
}

export const REMOTE_TABLE: Record<SyncTable, string> = {
  notetypes: "notetypes",
  notes: "notes",
  cards: "cards",
  revlog: "review_log",
  media: "media",
};

interface RemoteMedia {
  name: string;
  path: string;
  size: number;
  type: string;
}

const PUSH_BATCH = 500;
const PULL_PAGE = 1000;
const UPLOAD_CONCURRENCY = 4;
/**
 * Re-read a little before the last watermark: a row's updated_at is set when
 * it is written but becomes visible at commit, so a slow transaction can
 * commit a timestamp older than one already pulled.
 */
const PULL_OVERLAP_MS = 60_000;

export class AccountMismatchError extends Error {
  constructor() {
    super("This device holds data synced with a different account.");
  }
}

/** JSON with sorted keys: Postgres jsonb doesn't preserve key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function rowFor(db: StudyDB, remote: Remote, table: SyncTable, id: string, rec: unknown): Promise<RowWrite | undefined> {
  if (!rec) return { id, data: null, deleted: true };
  if (table !== "media") return { id, data: rec, deleted: false };
  const media = rec as MediaRecord;
  // A placeholder for a file that came from another device: nothing to upload.
  if (!media.data) return undefined;
  const path = media.remotePath ?? (await sha256Hex(media.name));
  await remote.uploadMedia(`${remote.userId}/${path}`, media.data);
  if (media.remotePath !== path) await db.media.update(media.name, { remotePath: path });
  const data: RemoteMedia = { name: media.name, path, size: media.data.size, type: media.data.type };
  return { id, data, deleted: false };
}

export async function push(db: StudyDB, remote: Remote): Promise<number> {
  let pushed = 0;
  for (;;) {
    const batch = await db.outbox.orderBy("seq").limit(PUSH_BATCH).toArray();
    if (!batch.length) return pushed;
    for (const table of SYNC_TABLES) {
      const entries = batch.filter((e) => e.table === table);
      if (!entries.length) continue;
      const recs = await db.table(table).bulkGet(entries.map((e) => e.id));
      const rows = await mapLimit(entries, UPLOAD_CONCURRENCY, (e, i) => rowFor(db, remote, table, e.id, recs[i]));
      const toSend = rows.filter((r): r is RowWrite => !!r);
      if (toSend.length) await remote.upsert(REMOTE_TABLE[table], toSend);
      pushed += toSend.length;
    }
    // Only clear entries that weren't changed again while we were pushing.
    await db.transaction("rw", db.outbox, async () => {
      const current = await db.outbox.bulkGet(batch.map((e) => e.key));
      await db.outbox.bulkDelete(batch.filter((e, i) => current[i]?.seq === e.seq).map((e) => e.key));
    });
  }
}

async function applyRows(db: StudyDB, table: SyncTable, rows: RemoteRow[]): Promise<number> {
  let changed = 0;
  await db.transaction("rw", [db.table(table), db.outbox], async () => {
    const pending = await db.outbox.bulkGet(rows.map((r) => outboxKey(table, r.id)));
    const incoming = rows.filter((_, i) => !pending[i]);
    const existing = await db.table(table).bulkGet(incoming.map((r) => r.id));
    const puts: unknown[] = [];
    const deletes: string[] = [];
    incoming.forEach((row, i) => {
      const local = existing[i];
      if (row.deleted) {
        if (local) deletes.push(row.id);
        return;
      }
      if (table === "media") {
        const m = row.data as RemoteMedia;
        const localMedia = local as MediaRecord | undefined;
        const sameFile = localMedia?.data && localMedia.data.size === m.size;
        if (sameFile && localMedia.remotePath === m.path) return;
        puts.push({ name: m.name, data: sameFile ? localMedia.data : undefined, size: m.size, remotePath: m.path });
        return;
      }
      if (local && canonical(local) === canonical(row.data)) return;
      puts.push(row.data);
    });
    await db.table(table).bulkPut(puts);
    await db.table(table).bulkDelete(deletes);
    changed = puts.length + deletes.length;
  });
  return changed;
}

export async function pull(db: StudyDB, remote: Remote): Promise<number> {
  let changed = 0;
  for (const table of SYNC_TABLES) {
    const metaKey = `pulled:${table}`;
    const since = (await db.meta.get(metaKey))?.value as string | undefined;
    const from = since ? new Date(Date.parse(since) - PULL_OVERLAP_MS).toISOString() : undefined;
    let watermark = since;
    for (let offset = 0; ; offset += PULL_PAGE) {
      const rows = await remote.changes(REMOTE_TABLE[table], from, offset, PULL_PAGE);
      changed += await applyRows(db, table, rows);
      for (const r of rows) if (!watermark || Date.parse(r.updated_at) > Date.parse(watermark)) watermark = r.updated_at;
      if (rows.length < PULL_PAGE) break;
    }
    if (watermark && watermark !== since) await db.meta.put({ key: metaKey, value: watermark });
  }
  return changed;
}

/** Binds this device to the signed-in account on first sync. */
async function checkAccount(db: StudyDB, remote: Remote): Promise<void> {
  const bound = (await db.meta.get("user"))?.value;
  if (bound === undefined) await db.meta.put({ key: "user", value: remote.userId });
  else if (bound !== remote.userId) throw new AccountMismatchError();
}

export async function sync(db: StudyDB, remote: Remote): Promise<{ pushed: number; pulled: number }> {
  await checkAccount(db, remote);
  const pushed = await push(db, remote);
  const pulled = await pull(db, remote);
  return { pushed, pulled };
}

/** Wipes local data so the device can sync with a different account. */
export async function resetLocal(db: StudyDB): Promise<void> {
  await db.transaction("rw", [...SYNC_TABLES.map((t) => db.table(t)), db.outbox, db.meta], async () => {
    for (const t of [...SYNC_TABLES, "outbox", "meta"]) await db.table(t).clear();
  });
}

const downloads = new Map<string, Promise<Blob | undefined>>();

/** Downloads a media file that was synced from another device. */
export function fetchMedia(db: StudyDB, remote: Remote, rec: MediaRecord): Promise<Blob | undefined> {
  if (rec.data) return Promise.resolve(rec.data);
  if (!rec.remotePath) return Promise.resolve(undefined);
  let p = downloads.get(rec.name);
  if (!p) {
    p = remote
      .downloadMedia(`${remote.userId}/${rec.remotePath}`)
      .then(async (blob) => {
        await db.media.update(rec.name, { data: blob, size: blob.size });
        return blob;
      })
      .finally(() => downloads.delete(rec.name));
    downloads.set(rec.name, p);
  }
  return p;
}
