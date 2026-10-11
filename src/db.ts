import Dexie, { type Table } from "dexie";
import type { CardRecord, MediaRecord, Note, Notetype, ReviewRecord } from "./model";

/** Local tables that are mirrored to the sync server. */
export type SyncTable = "notetypes" | "notes" | "cards" | "revlog" | "media";
export const SYNC_TABLES: SyncTable[] = ["notetypes", "notes", "cards", "revlog", "media"];

/** A record changed locally that still has to be pushed (one entry per record). */
export interface OutboxEntry {
  /** `${table}\x1f${id}` */
  key: string;
  table: SyncTable;
  id: string;
  /** Bumped on every change, so a push only clears entries it actually sent. */
  seq: number;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

/** Everything lives in this browser's IndexedDB; sync is optional. */
export class StudyDB extends Dexie {
  notetypes!: Table<Notetype, string>;
  notes!: Table<Note, string>;
  cards!: Table<CardRecord, string>;
  media!: Table<MediaRecord, string>;
  revlog!: Table<ReviewRecord, string>;
  outbox!: Table<OutboxEntry, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name = "study-hard") {
    super(name);
    this.version(1).stores({
      notetypes: "id",
      notes: "guid, notetypeId",
      cards: "id, noteGuid, deck",
      media: "name",
      reviews: "++id, cardId, deck, time",
    });
    // v2: string review ids (unique across devices) and sync bookkeeping.
    // Existing records are queued so the first sync uploads them.
    this.version(2)
      .stores({ revlog: "id, cardId, deck, time", outbox: "key, seq", meta: "key" })
      .upgrade(async (tx) => {
        const old = (await tx.table("reviews").toArray()) as (Omit<ReviewRecord, "id"> & { id?: number })[];
        await tx.table("revlog").bulkAdd(old.map((r) => ({ ...r, id: crypto.randomUUID() })));
        let seq = 0;
        for (const table of SYNC_TABLES) {
          const keys = (await tx.table(table).toCollection().primaryKeys()) as string[];
          await tx.table("outbox").bulkPut(keys.map((id) => ({ key: `${table}\x1f${id}`, table, id, seq: ++seq })));
        }
      });
    this.version(3).stores({ reviews: null });
  }
}

export const db = new StudyDB();
