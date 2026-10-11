// Collection operations on top of IndexedDB: import, deck counts, the study
// queue, answering/undo, deletion and export.

import { zipSync } from "fflate";
import type { Grade } from "ts-fsrs";
import { db } from "./db";
import { buildCrowdAnki } from "./importers/crowdanki";
import type { CardRecord, ImportBundle, Note, ReviewRecord } from "./model";
import { referencedMedia } from "./render/media";
import { answer, dayStart, newSchedule, type Settings } from "./scheduler";

const LEARN_AHEAD_MS = 20 * 60_000;
const DAY_MS = 86_400_000;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  flac: "audio/flac", opus: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};

export function mimeFor(name: string): string {
  return MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export interface ImportSummary {
  notes: number;
  newCards: number;
  updatedCards: number;
  media: number;
  decks: string[];
}

export async function saveBundle(bundle: ImportBundle): Promise<ImportSummary> {
  const now = new Date();
  const ids = bundle.cards.map((c) => `${c.noteGuid}:${c.ord}`);
  let newCards = 0;
  await db.transaction("rw", [db.notetypes, db.notes, db.cards, db.media], async () => {
    await db.notetypes.bulkPut(bundle.notetypes);
    await db.notes.bulkPut(bundle.notes);
    const existing = await db.cards.bulkGet(ids);
    const records: CardRecord[] = bundle.cards.map((c, i) => {
      const old = existing[i];
      if (!old) newCards++;
      // Keep local review progress; only adopt the package's schedule for
      // cards that were never studied here.
      const keepOld = old && old.sched.state !== 0;
      return {
        id: ids[i],
        noteGuid: c.noteGuid,
        ord: c.ord,
        deck: c.deck,
        position: c.position,
        suspended: old ? old.suspended : c.suspended,
        sched: keepOld ? old.sched : (c.sched ?? old?.sched ?? newSchedule(now)),
      };
    });
    await db.cards.bulkPut(records);
    await db.media.bulkPut(
      [...bundle.media].map(([name, data]) => ({ name, data: new Blob([data as BlobPart], { type: mimeFor(name) }) })),
    );
  });
  return {
    notes: bundle.notes.length,
    newCards,
    updatedCards: bundle.cards.length - newCards,
    media: bundle.media.size,
    decks: [...new Set(bundle.cards.map((c) => c.deck))].sort(),
  };
}

// ----------------------------------------------------------- deck tree --

export interface DeckCounts {
  new: number;
  learn: number;
  review: number;
  total: number;
}

export interface DeckNode {
  name: string;
  label: string;
  depth: number;
  counts: DeckCounts;
}

const inDeck = (cardDeck: string, deck: string) => cardDeck === deck || cardDeck.startsWith(`${deck}::`);

async function cardsIn(deck: string): Promise<CardRecord[]> {
  return db.cards.where("deck").equals(deck).or("deck").startsWith(`${deck}::`).toArray();
}

async function todaysReviews(deck: string, settings: Settings): Promise<ReviewRecord[]> {
  const since = dayStart(settings);
  return (await db.reviews.where("time").aboveOrEqual(since).toArray()).filter((r) => inDeck(r.deck, deck));
}

function countCards(cards: CardRecord[], today: ReviewRecord[], settings: Settings, now: number): DeckCounts {
  const dayEnd = dayStart(settings, new Date(now)) + DAY_MS;
  const counts = { new: 0, learn: 0, review: 0, total: cards.length };
  for (const c of cards) {
    if (c.suspended) continue;
    if (c.sched.state === 0) counts.new++;
    else if (c.sched.state === 2 && c.sched.due < dayEnd) counts.review++;
    else if (c.sched.state !== 2 && c.sched.due <= now + LEARN_AHEAD_MS) counts.learn++;
  }
  const newDone = today.filter((r) => r.prevState === 0).length;
  const reviewsDone = today.filter((r) => r.prevState === 2).length;
  counts.new = Math.max(0, Math.min(counts.new, settings.newPerDay - newDone));
  counts.review = Math.max(0, Math.min(counts.review, settings.reviewsPerDay - reviewsDone));
  return counts;
}

export async function deckTree(settings: Settings): Promise<DeckNode[]> {
  const cards = await db.cards.toArray();
  const today = await db.reviews.where("time").aboveOrEqual(dayStart(settings)).toArray();
  const names = new Set<string>();
  for (const c of cards) {
    const parts = c.deck.split("::");
    parts.forEach((_, i) => names.add(parts.slice(0, i + 1).join("::")));
  }
  const now = Date.now();
  return [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({
      name,
      label: name.split("::").pop()!,
      depth: name.split("::").length - 1,
      counts: countCards(
        cards.filter((c) => inDeck(c.deck, name)),
        today.filter((r) => inDeck(r.deck, name)),
        settings,
        now,
      ),
    }));
}

// --------------------------------------------------------------- queue --

export interface QueueState {
  card?: CardRecord;
  counts: DeckCounts;
  /** When nothing is due now but learning cards are pending later today. */
  nextDue?: number;
}

export async function nextCard(deck: string, settings: Settings, skip?: string): Promise<QueueState> {
  const now = Date.now();
  const cards = (await cardsIn(deck)).filter((c) => !c.suspended);
  const counts = countCards(cards, await todaysReviews(deck, settings), settings, now);
  const dayEnd = dayStart(settings) + DAY_MS;
  const byDue = (a: CardRecord, b: CardRecord) => a.sched.due - b.sched.due;

  const learning = cards.filter((c) => c.sched.state === 1 || c.sched.state === 3).sort(byDue);
  const reviews = counts.review > 0 ? cards.filter((c) => c.sched.state === 2 && c.sched.due < dayEnd).sort(byDue) : [];
  const fresh = counts.new > 0
    ? cards.filter((c) => c.sched.state === 0).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    : [];

  const pick = (ok: (c: CardRecord) => boolean) =>
    learning.find((c) => c.sched.due <= now && ok(c)) ??
    reviews.find(ok) ??
    fresh.find(ok) ??
    learning.find((c) => c.sched.due <= now + LEARN_AHEAD_MS && ok(c));
  // Prefer a different card than the one just answered, if any other is ready.
  const card = pick((c) => c.id !== skip) ?? pick(() => true);
  const later = learning.find((c) => c.sched.due < dayEnd);
  return { card, counts, nextDue: card ? undefined : later?.sched.due };
}

export interface UndoEntry {
  card: CardRecord;
  reviewId: number;
}

export async function recordAnswer(card: CardRecord, rating: Grade, settings: Settings): Promise<UndoEntry> {
  const now = new Date();
  const updated = { ...card, sched: answer(card.sched, rating, settings, now) };
  let reviewId = 0;
  await db.transaction("rw", [db.cards, db.reviews], async () => {
    await db.cards.put(updated);
    reviewId = await db.reviews.add({
      cardId: card.id,
      deck: card.deck,
      time: now.getTime(),
      rating,
      prevState: card.sched.state,
    });
  });
  return { card, reviewId };
}

export async function undo(entry: UndoEntry): Promise<void> {
  await db.transaction("rw", [db.cards, db.reviews], async () => {
    await db.cards.put(entry.card);
    await db.reviews.delete(entry.reviewId);
  });
}

export async function setSuspended(card: CardRecord, suspended: boolean): Promise<void> {
  await db.cards.update(card.id, { suspended });
}

// ------------------------------------------------------ delete / export --

export async function deleteDeck(deck: string): Promise<void> {
  await db.transaction("rw", [db.cards, db.notes, db.reviews], async () => {
    const cards = await cardsIn(deck);
    await db.cards.bulkDelete(cards.map((c) => c.id));
    const guids = [...new Set(cards.map((c) => c.noteGuid))];
    const stillUsed = await db.cards.where("noteGuid").anyOf(guids).toArray();
    const used = new Set(stillUsed.map((c) => c.noteGuid));
    await db.notes.bulkDelete(guids.filter((g) => !used.has(g)));
    await db.reviews.where("cardId").anyOf(cards.map((c) => c.id)).delete();
  });
}

/** Exports a deck tree as a CrowdAnki folder, zipped. */
export async function exportCrowdAnki(deck: string): Promise<Uint8Array> {
  const cards = (await cardsIn(deck)).sort((a, b) => a.position - b.position);
  const deckOf = new Map<string, string>();
  for (const c of cards) if (!deckOf.has(c.noteGuid)) deckOf.set(c.noteGuid, c.deck);
  const notes = (await db.notes.bulkGet([...deckOf.keys()])).filter((n): n is Note => !!n);
  const notetypes = (await db.notetypes.bulkGet([...new Set(notes.map((n) => n.notetypeId))])).filter((n) => !!n);

  const wanted = new Set<string>();
  notes.forEach((n) => n.fields.forEach((f) => referencedMedia(f).forEach((m) => wanted.add(m))));
  notetypes.forEach((nt) => {
    referencedMedia(nt.css).forEach((m) => wanted.add(m));
    nt.templates.forEach((t) => referencedMedia(t.qfmt + t.afmt).forEach((m) => wanted.add(m)));
  });
  const media = (await db.media.bulkGet([...wanted])).filter((m) => !!m);

  const dir = deck.replace(/::/g, " - ").replace(/[\\/:*?"<>|]/g, "_");
  const json = buildCrowdAnki({
    rootDeck: deck,
    notetypes,
    notes: notes.map((note) => ({ note, deck: deckOf.get(note.guid)! })),
    mediaNames: media.map((m) => m.name),
  });
  const files: Record<string, Uint8Array> = {
    [`${dir}/deck.json`]: new TextEncoder().encode(JSON.stringify(json, null, 4)),
  };
  for (const m of media) files[`${dir}/media/${m.name}`] = new Uint8Array(await m.data.arrayBuffer());
  return zipSync(files, { level: 6 });
}
