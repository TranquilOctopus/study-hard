// Shared data model. Notes are keyed by their Anki GUID so re-importing a
// package updates the existing notes instead of duplicating them.

export interface Template {
  name: string;
  qfmt: string;
  afmt: string;
}

export interface Notetype {
  id: string;
  name: string;
  kind: "normal" | "cloze";
  css: string;
  fields: string[];
  templates: Template[];
}

export interface Deck {
  /** Full name using "::" as the hierarchy separator. */
  name: string;
}

export interface Note {
  guid: string;
  notetypeId: string;
  fields: string[];
  tags: string[];
}

/** Scheduling state, mirroring ts-fsrs' Card with dates as epoch millis. */
export interface Schedule {
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  /** 0 new, 1 learning, 2 review, 3 relearning (ts-fsrs State). */
  state: number;
  lastReview?: number;
}

export interface CardRecord {
  /** `${noteGuid}:${ord}` */
  id: string;
  noteGuid: string;
  ord: number;
  deck: string;
  /** Ordering for new cards. */
  position: number;
  suspended: boolean;
  sched: Schedule;
}

export interface ReviewRecord {
  /** Random UUID, so reviews from different devices never collide. */
  id: string;
  cardId: string;
  deck: string;
  time: number;
  rating: number;
  prevState: number;
}

export interface MediaRecord {
  name: string;
  /** Absent until a file synced from another device is first needed. */
  data?: Blob;
  size?: number;
  /** Path of the file in the sync storage bucket, below the user's folder. */
  remotePath?: string;
}

/** Result of reading any package format, before it is stored. */
export interface ImportBundle {
  notetypes: Notetype[];
  notes: Note[];
  cards: ImportedCard[];
  media: Map<string, Uint8Array>;
}

export interface ImportedCard {
  noteGuid: string;
  ord: number;
  deck: string;
  position: number;
  suspended: boolean;
  /** Present when the package carried review history. */
  sched?: Schedule;
}
