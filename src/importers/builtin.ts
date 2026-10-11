import type { ImportedCard, Note, Notetype } from "../model";
import { cardOrdinals } from "../render/template";

const BASE_CSS = `.card {
    font-family: arial;
    font-size: 20px;
    line-height: 1.5;
    text-align: center;
    color: black;
    background-color: white;
}
.nightMode.card, .nightMode .card {
    color: #e5e7eb;
    background-color: #1f2128;
}
`;

export const BASIC: Notetype = {
  id: "builtin-basic",
  name: "Basic",
  kind: "normal",
  css: BASE_CSS,
  fields: ["Front", "Back"],
  templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}" }],
};

export const CLOZE: Notetype = {
  id: "builtin-cloze",
  name: "Cloze",
  kind: "cloze",
  css: `${BASE_CSS}.cloze {
    font-weight: bold;
    color: blue;
}
.nightMode .cloze {
    color: lightblue;
}
`,
  fields: ["Text", "Back Extra"],
  templates: [{ name: "Cloze", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}<br>\n{{Back Extra}}" }],
};

/** Creates the cards a freshly imported note should have. */
export function generateCards(notetype: Notetype, note: Note, deck: string, position: number): ImportedCard[] {
  return cardOrdinals(notetype, note).map((ord) => ({
    noteGuid: note.guid,
    ord,
    deck,
    position,
    suspended: false,
  }));
}

/** Short stable hash (FNV-1a, 2x32 bit) used for generated GUIDs. */
export function stableHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
