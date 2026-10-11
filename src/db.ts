import Dexie, { type Table } from "dexie";
import type { CardRecord, MediaRecord, Note, Notetype, ReviewRecord } from "./model";

/** Everything lives in this browser's IndexedDB; nothing is sent anywhere. */
export class StudyDB extends Dexie {
  notetypes!: Table<Notetype, string>;
  notes!: Table<Note, string>;
  cards!: Table<CardRecord, string>;
  media!: Table<MediaRecord, string>;
  reviews!: Table<ReviewRecord, number>;

  constructor(name = "study-hard") {
    super(name);
    this.version(1).stores({
      notetypes: "id",
      notes: "guid, notetypeId",
      cards: "id, noteGuid, deck",
      media: "name",
      reviews: "++id, cardId, deck, time",
    });
  }
}

export const db = new StudyDB();
