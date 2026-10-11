// CSV / TSV import, including the "#separator:", "#html:", "#deck:",
// "#notetype:", "#tags:" and "#... column:" headers written by Anki's
// plain-text exporter.

import type { ImportBundle, ImportedCard, Note } from "../model";
import { escapeHtml } from "../render/html";
import { BASIC, CLOZE, generateCards, stableHash } from "./builtin";

const SEPARATORS: Record<string, string> = {
  tab: "\t",
  comma: ",",
  semicolon: ";",
  space: " ",
  pipe: "|",
  colon: ":",
};

export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function guessSeparator(line: string, fileName: string): string {
  if (line.includes("\t") || /\.tsv$/i.test(fileName)) return "\t";
  const count = (ch: string) => line.split(ch).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

const HTML_TAG = /<\/?(?:br|div|b|i|u|img|span|p|sub|sup|ul|ol|li|a|font|table|tr|td|em|strong|hr|code|pre)\b[^>]*>/i;

export function readDelimited(text: string, fileName: string): ImportBundle {
  const headers = new Map<string, string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let bodyStart = 0;
  while (bodyStart < lines.length && /^#[\w ]+:/.test(lines[bodyStart])) {
    const line = lines[bodyStart++];
    const idx = line.indexOf(":");
    headers.set(line.slice(1, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  const body = lines.slice(bodyStart).join("\n");

  const sepHeader = headers.get("separator");
  const sep = sepHeader
    ? (SEPARATORS[sepHeader.toLowerCase()] ?? sepHeader)
    : guessSeparator(lines[bodyStart] ?? "", fileName);
  const rows = parseDelimited(body, sep);

  const col = (name: string) => {
    const v = headers.get(`${name} column`);
    return v ? Number(v) - 1 : -1;
  };
  const guidCol = col("guid");
  const deckCol = col("deck");
  const tagsCol = col("tags");
  const notetypeCol = col("notetype");
  const meta = new Set([guidCol, deckCol, tagsCol, notetypeCol]);

  const htmlHeader = headers.get("html");
  const isHtml = htmlHeader ? htmlHeader === "true" : rows.some((r) => r.some((f) => HTML_TAG.test(f)));
  const defaultDeck = headers.get("deck") ?? fileName.replace(/\.[^.]+$/, "");
  const extraTags = (headers.get("tags") ?? "").split(/\s+/).filter(Boolean);
  const notetypeHeader = headers.get("notetype") ?? "";

  const notes: Note[] = [];
  const cards: ImportedCard[] = [];
  let usedBasic = false;
  let usedCloze = false;
  rows.forEach((row, i) => {
    const content = row.filter((_, j) => !meta.has(j)).map((f) => (isHtml ? f : escapeHtml(f)));
    const rowType = notetypeCol >= 0 ? row[notetypeCol] : notetypeHeader;
    const cloze = /cloze/i.test(rowType) || (!rowType && /\{\{c\d+::/.test(content[0] ?? ""));
    const notetype = cloze ? CLOZE : BASIC;
    if (cloze) usedCloze = true;
    else usedBasic = true;
    const deck = (deckCol >= 0 && row[deckCol]) || defaultDeck;
    const fields = notetype.fields.map((_, j) => content[j] ?? "");
    const note: Note = {
      guid: (guidCol >= 0 && row[guidCol]) || `csv-${stableHash(`${deck}\x1f${fields[0]}`)}`,
      notetypeId: notetype.id,
      fields,
      tags: [...extraTags, ...(tagsCol >= 0 ? (row[tagsCol] ?? "").split(/\s+/).filter(Boolean) : [])],
    };
    notes.push(note);
    cards.push(...generateCards(notetype, note, deck, i));
  });

  return {
    notetypes: [...(usedBasic ? [BASIC] : []), ...(usedCloze ? [CLOZE] : [])],
    notes,
    cards,
    media: new Map(),
  };
}
