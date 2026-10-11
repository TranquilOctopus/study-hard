// Anki card template engine: {{Field}}, {{#Field}}..{{/Field}},
// {{^Field}}..{{/Field}}, chained filters ({{text:hint:Field}}), cloze,
// type-in answers, furigana and Anki's special fields.

import type { Note, Notetype } from "../model";
import { clozeNumbers, clozeOnly, clozeTypeAnswer, renderCloze } from "./cloze";
import { escapeHtml, fieldIsEmpty, stripHtml } from "./html";

type Node =
  | { kind: "text"; text: string }
  | { kind: "field"; name: string; filters: string[] }
  | { kind: "cond"; name: string; negated: boolean; children: Node[] };

const cache = new Map<string, Node[]>();

export function parseTemplate(src: string): Node[] {
  const hit = cache.get(src);
  if (hit) return hit;
  const root: Node[] = [];
  const stack: { node: Extract<Node, { kind: "cond" }>; parent: Node[] }[] = [];
  let out = root;
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  for (let m; (m = re.exec(src)); ) {
    if (m.index > last) out.push({ kind: "text", text: src.slice(last, m.index) });
    last = re.lastIndex;
    const tag = m[1].trim();
    if (tag[0] === "#" || tag[0] === "^") {
      const node = { kind: "cond" as const, name: tag.slice(1).trim(), negated: tag[0] === "^", children: [] };
      out.push(node);
      stack.push({ node, parent: out });
      out = node.children;
    } else if (tag[0] === "/") {
      const name = tag.slice(1).trim();
      const idx = stack.map((s) => s.node.name).lastIndexOf(name);
      if (idx < 0) {
        out.push({ kind: "text", text: m[0] });
        continue;
      }
      out = stack[idx].parent;
      stack.length = idx;
    } else {
      const parts = tag.split(":");
      const name = parts.pop()!.trim();
      out.push({ kind: "field", name, filters: parts.map((p) => p.trim()) });
    }
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  cache.set(src, root);
  return root;
}

export interface RenderContext {
  notetype: Notetype;
  note: Note;
  /** Card ordinal: template index for normal notetypes, cloze number - 1 for cloze. */
  ord: number;
  deck: string;
  side: "question" | "answer";
  /** Rendered question, substituted for {{FrontSide}} on the answer side. */
  frontSide?: string;
  /** What the user typed into a {{type:...}} box, shown on the answer side. */
  typed?: string;
}

export interface RenderedSide {
  html: string;
  /** Expected answer when the template contains a {{type:...}} field. */
  typeAnswer?: string;
}

function fieldMap(ctx: RenderContext): Map<string, string> {
  const map = new Map<string, string>();
  ctx.notetype.fields.forEach((name, i) => map.set(name, ctx.note.fields[i] ?? ""));
  const template = ctx.notetype.kind === "cloze" ? ctx.notetype.templates[0] : ctx.notetype.templates[ctx.ord];
  const deckParts = ctx.deck.split("::");
  const special: Record<string, string> = {
    Tags: ctx.note.tags.join(" "),
    Type: ctx.notetype.name,
    Deck: ctx.deck,
    Subdeck: deckParts[deckParts.length - 1],
    Card: template?.name ?? "",
    CardFlag: "",
    FrontSide: ctx.side === "answer" ? (ctx.frontSide ?? "") : "",
  };
  for (const [k, v] of Object.entries(special)) if (!map.has(k)) map.set(k, v);
  if (ctx.notetype.kind === "cloze") map.set(`c${ctx.ord + 1}`, "1");
  return map;
}

function furigana(text: string, mode: "furigana" | "kana" | "kanji"): string {
  return text.replace(/ ?([^ >]+?)\[(.+?)\]/g, (_m, base: string, reading: string) => {
    if (mode === "kana") return reading;
    if (mode === "kanji") return base;
    return `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>`;
  });
}

function compareTyped(typed: string, expected: string): string {
  const ok = typed.trim().normalize() === expected.trim().normalize();
  const shown = typed.trim() ? escapeHtml(typed) : "<i>(nothing typed)</i>";
  if (ok) return `<div class="typeans"><span class="typeGood">${escapeHtml(expected)}</span></div>`;
  return (
    `<div class="typeans"><span class="typeBad">${shown}</span>` +
    `<br><span class="typearrow">↓</span><br><span class="typeMissed">${escapeHtml(expected)}</span></div>`
  );
}

let hintCounter = 0;

export function renderSide(template: string, ctx: RenderContext): RenderedSide {
  const fields = fieldMap(ctx);
  const result: RenderedSide = { html: "" };

  const applyFilters = (name: string, filters: string[]): string => {
    let value = fields.get(name);
    if (value === undefined) return `{unknown field ${escapeHtml(name)}}`;
    if (filters[0] === "type") {
      const isCloze = filters.includes("cloze");
      const expected = isCloze ? clozeTypeAnswer(value, ctx.ord + 1) : stripHtml(value);
      result.typeAnswer = expected;
      if (ctx.side === "question") {
        return `<input type="text" id="typeans" autocomplete="off" autocapitalize="off" spellcheck="false">`;
      }
      return compareTyped(ctx.typed ?? "", expected);
    }
    // Filters apply right to left: {{a:b:Field}} == a(b(Field)).
    for (const filter of [...filters].reverse()) {
      if (filter === "text") value = stripHtml(value);
      else if (filter === "cloze") value = renderCloze(value, ctx.ord + 1, ctx.side);
      else if (filter === "cloze-only") value = clozeOnly(value, ctx.ord + 1);
      else if (filter === "furigana" || filter === "kana" || filter === "kanji") value = furigana(value, filter);
      else if (filter === "hint") {
        if (fieldIsEmpty(value)) continue;
        const id = `hint${++hintCounter}`;
        value =
          `<a class="hint" href="#" onclick="this.style.display='none';` +
          `document.getElementById('${id}').style.display='block';return false;">${escapeHtml(name)}</a>` +
          `<div id="${id}" class="hint" style="display:none">${value}</div>`;
      } else if (filter.startsWith("tts")) value = "";
      // Unknown filters (e.g. from add-ons) leave the value unchanged.
    }
    return value;
  };

  const render = (nodes: Node[]): string =>
    nodes
      .map((n) => {
        if (n.kind === "text") return n.text;
        if (n.kind === "field") return applyFilters(n.name, n.filters);
        const empty = fieldIsEmpty(fields.get(n.name) ?? "");
        return empty === n.negated ? render(n.children) : "";
      })
      .join("");

  result.html = render(parseTemplate(template));
  return result;
}

export interface RenderedCard {
  question: string;
  answer: string;
  typeAnswer?: string;
}

export function renderCard(
  notetype: Notetype,
  note: Note,
  ord: number,
  deck: string,
  typed?: string,
): RenderedCard {
  const template = notetype.kind === "cloze" ? notetype.templates[0] : notetype.templates[ord];
  if (!template) return { question: `<div>Missing card template ${ord + 1}</div>`, answer: "" };
  const base = { notetype, note, ord, deck };
  const q = renderSide(template.qfmt, { ...base, side: "question" });
  // Like Anki, the type-in box is dropped from {{FrontSide}} on the answer.
  const frontSide = q.html.replace(/<input type="text" id="typeans"[^>]*>/, "");
  const a = renderSide(template.afmt, { ...base, side: "answer", frontSide, typed });
  return {
    question: convertLatex(q.html),
    answer: convertLatex(a.html),
    typeAnswer: q.typeAnswer ?? a.typeAnswer,
  };
}

/**
 * Anki's image-based LaTeX tags become MathJax delimiters, so decks written
 * for desktop LaTeX also render here.
 */
export function convertLatex(html: string): string {
  return html
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_m, tex: string) => `\\[${tex}\\]`)
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_m, tex: string) => `\\(${tex}\\)`)
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_m, tex: string) =>
      tex
        .replace(/\$\$([\s\S]+?)\$\$/g, (_n, t: string) => `\\[${t}\\]`)
        .replace(/\$([^$]+?)\$/g, (_n, t: string) => `\\(${t}\\)`),
    );
}

/** Which card ordinals a note produces (Anki's card generation rules). */
export function cardOrdinals(notetype: Notetype, note: Note): number[] {
  if (notetype.kind === "cloze") {
    const nums = new Set<number>();
    const clozeFields = new Set<string>();
    for (const n of flatten(parseTemplate(notetype.templates[0]?.qfmt ?? ""))) {
      if (n.kind === "field" && n.filters.includes("cloze")) clozeFields.add(n.name);
    }
    notetype.fields.forEach((name, i) => {
      if (clozeFields.size === 0 || clozeFields.has(name)) {
        clozeNumbers(note.fields[i] ?? "").forEach((c) => nums.add(c));
      }
    });
    return [...nums].sort((a, b) => a - b).map((c) => c - 1);
  }
  const fields = new Map(notetype.fields.map((name, i) => [name, note.fields[i] ?? ""]));
  const nonEmpty = (name: string) => !fieldIsEmpty(fields.get(name) ?? "");
  const usesNonEmpty = (nodes: Node[]): boolean =>
    nodes.some((n) => {
      if (n.kind === "field") return fields.has(n.name) && nonEmpty(n.name);
      if (n.kind === "cond") return nonEmpty(n.name) !== n.negated && usesNonEmpty(n.children);
      return false;
    });
  const ords = notetype.templates.flatMap((t, i) => (usesNonEmpty(parseTemplate(t.qfmt)) ? [i] : []));
  // Anki always keeps at least the first card so a note is never orphaned.
  return ords.length ? ords : [0];
}

function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (n.kind === "cond" ? [n, ...flatten(n.children)] : [n]));
}
