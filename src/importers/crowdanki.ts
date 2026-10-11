// CrowdAnki: the open, git-friendly JSON deck format (deck.json + media/).
// https://github.com/Stvad/CrowdAnki

import type { ImportBundle, ImportedCard, Note, Notetype } from "../model";
import { generateCards, stableHash } from "./builtin";

interface CrowdAnkiModel {
  crowdanki_uuid: string;
  name: string;
  type: number;
  css?: string;
  flds: { name: string; ord: number }[];
  tmpls: { name: string; ord: number; qfmt: string; afmt: string }[];
}

interface CrowdAnkiNote {
  guid?: string;
  note_model_uuid: string;
  fields: string[];
  tags?: string[];
}

interface CrowdAnkiDeck {
  name: string;
  children?: CrowdAnkiDeck[];
  note_models?: CrowdAnkiModel[];
  notes?: CrowdAnkiNote[];
  media_files?: string[];
}

/** Locates deck.json within a set of files (zip contents or a picked folder). */
export function findDeckJson(files: Map<string, Uint8Array>): string | undefined {
  return [...files.keys()]
    .filter((p) => /(^|\/)deck\.json$/i.test(p) || (files.size === 1 && /\.json$/i.test(p)))
    .sort((a, b) => a.length - b.length)[0];
}

export function readCrowdAnki(files: Map<string, Uint8Array>): ImportBundle {
  const deckPath = findDeckJson(files);
  if (!deckPath) throw new Error("No CrowdAnki deck.json found");
  const root = JSON.parse(new TextDecoder().decode(files.get(deckPath))) as CrowdAnkiDeck;
  if (!root || typeof root.name !== "string") throw new Error(`${deckPath} is not a CrowdAnki deck`);

  const notetypes = new Map<string, Notetype>();
  const notes: Note[] = [];
  const cards: ImportedCard[] = [];
  const mediaNames = new Set<string>();

  const visit = (deck: CrowdAnkiDeck, parent: string | undefined) => {
    let name = deck.name;
    if (parent && !name.startsWith(`${parent}::`)) name = `${parent}::${name}`;
    for (const m of deck.note_models ?? []) {
      notetypes.set(m.crowdanki_uuid, {
        id: `crowdanki-${m.crowdanki_uuid}`,
        name: m.name,
        kind: m.type === 1 ? "cloze" : "normal",
        css: m.css ?? "",
        fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
        templates: [...m.tmpls]
          .sort((a, b) => a.ord - b.ord)
          .map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
      });
    }
    for (const n of deck.notes ?? []) {
      const notetype = notetypes.get(n.note_model_uuid);
      if (!notetype) continue;
      const note: Note = {
        guid: n.guid || `ca-${stableHash(`${n.note_model_uuid}\x1f${n.fields[0] ?? ""}`)}`,
        notetypeId: notetype.id,
        fields: n.fields,
        tags: n.tags ?? [],
      };
      notes.push(note);
      cards.push(...generateCards(notetype, note, name, notes.length));
    }
    deck.media_files?.forEach((f) => mediaNames.add(f));
    deck.children?.forEach((child) => visit(child, name));
  };
  visit(root, undefined);

  const dir = deckPath.slice(0, deckPath.lastIndexOf("/") + 1);
  const media = new Map<string, Uint8Array>();
  for (const [path, data] of files) {
    if (path.startsWith(`${dir}media/`)) media.set(path.slice(dir.length + 6), data);
  }
  return { notetypes: [...notetypes.values()], notes, cards, media };
}

// ---------------------------------------------------------------- export --

/** Deterministic UUID-shaped id, so re-exports don't create new note models. */
export function stableUuid(seed: string): string {
  const h = stableHash(seed) + stableHash(`${seed}\x00`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const DECK_CONFIG = {
  __type__: "DeckConfig",
  autoplay: true,
  dyn: false,
  lapse: { delays: [10.0], leechAction: 1, leechFails: 8, minInt: 1, mult: 0.0 },
  maxTaken: 60,
  name: "Default",
  new: { bury: false, delays: [1.0, 10.0], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
  replayq: true,
  rev: { bury: false, ease4: 1.3, hardFactor: 1.2, ivlFct: 1.0, maxIvl: 36500, perDay: 200 },
  timer: 0,
};

export interface ExportInput {
  rootDeck: string;
  notetypes: Notetype[];
  /** Each note with the deck its first card lives in. */
  notes: { note: Note; deck: string }[];
  mediaNames: string[];
}

/** Builds a CrowdAnki deck.json object for a deck tree. */
export function buildCrowdAnki(input: ExportInput): object {
  const configUuid = stableUuid(`deck-config:${input.rootDeck}`);
  const modelUuid = (nt: Notetype) => (nt.id.startsWith("crowdanki-") ? nt.id.slice(10) : stableUuid(`notetype:${nt.id}`));

  const noteModels = input.notetypes.map((nt) => ({
    __type__: "NoteModel",
    crowdanki_uuid: modelUuid(nt),
    css: nt.css,
    flds: nt.fields.map((name, ord) => ({
      font: "Arial", media: [], name, ord, rtl: false, size: 20, sticky: false,
    })),
    latexPost: "\\end{document}",
    latexPre:
      "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n" +
      "\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
    name: nt.name,
    sortf: 0,
    tags: [],
    tmpls: nt.templates.map((t, ord) => ({
      afmt: t.afmt, bafmt: "", bqfmt: "", did: null, name: t.name, ord, qfmt: t.qfmt,
    })),
    type: nt.kind === "cloze" ? 1 : 0,
    vers: [],
  }));
  const uuidById = new Map(input.notetypes.map((nt) => [nt.id, modelUuid(nt)]));

  const makeDeck = (name: string): Record<string, unknown> => ({
    __type__: "Deck",
    children: [] as Record<string, unknown>[],
    crowdanki_uuid: stableUuid(`deck:${name}`),
    deck_config_uuid: configUuid,
    desc: "",
    dyn: 0,
    extendNew: 0,
    extendRev: 0,
    media_files: [] as string[],
    name,
    notes: [] as unknown[],
  });
  const root = makeDeck(input.rootDeck);
  Object.assign(root, {
    deck_configurations: [{ ...DECK_CONFIG, crowdanki_uuid: configUuid }],
    media_files: [...input.mediaNames].sort(),
    note_models: noteModels,
  });

  const decks = new Map<string, Record<string, unknown>>([[input.rootDeck, root]]);
  const deckFor = (name: string): Record<string, unknown> => {
    const hit = decks.get(name);
    if (hit) return hit;
    if (!name.startsWith(`${input.rootDeck}::`)) return root;
    const parentName = name.slice(0, name.lastIndexOf("::"));
    const deck = makeDeck(name);
    (deckFor(parentName).children as Record<string, unknown>[]).push(deck);
    decks.set(name, deck);
    return deck;
  };
  for (const { note, deck } of input.notes) {
    (deckFor(deck).notes as unknown[]).push({
      __type__: "Note",
      data: "",
      fields: note.fields,
      flags: 0,
      guid: note.guid,
      note_model_uuid: uuidById.get(note.notetypeId),
      tags: note.tags,
    });
  }
  return root;
}
