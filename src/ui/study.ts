import type { Grade } from "ts-fsrs";
import { db } from "../db";
import type { CardRecord, Note, Notetype } from "../model";
import { CardFrame } from "../render/cardFrame";
import { inlineMedia, type MediaLookup } from "../render/media";
import { renderCard } from "../render/template";
import { formatInterval, GRADES, loadSettings, preview } from "../scheduler";
import { nextCard, recordAnswer, setSuspended, undo, type DeckCounts, type UndoEntry } from "../store";
import { h, toast } from "./dom";

const dataUrls = new Map<string, string>();

const mediaLookup: MediaLookup = async (name) => {
  const hit = dataUrls.get(name);
  if (hit) return hit;
  const rec = await db.media.get(name);
  if (!rec) return undefined;
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(rec.data);
  });
  if (dataUrls.size > 300) dataUrls.delete(dataUrls.keys().next().value!);
  dataUrls.set(name, url);
  return url;
};

/** Mounts the review screen for `deck`; returns a cleanup function. */
export function mountStudy(root: HTMLElement, deck: string, onExit: () => void): () => void {
  const settings = loadSettings();
  let current: { card: CardRecord; note: Note; notetype: Notetype; css: string } | undefined;
  let side: "question" | "answer" | "done" | "loading" = "loading";
  let undoStack: UndoEntry[] = [];
  let lastShown: string | undefined;
  let refreshTimer: number | undefined;

  const frame = new CardFrame({ onKey: (key) => handleKey(key) });
  const counts = h("div.counts", { attrs: { "aria-label": "Remaining cards" } });
  const undoBtn = h("button.ghost", { type: "button", textContent: "Undo", title: "Undo last answer (Z)", disabled: true, onclick: () => void doUndo() });
  const suspendBtn = h("button.ghost", { type: "button", textContent: "Suspend", title: "Suspend this card (@)", onclick: () => void doSuspend() });
  const bar = h("div.answer-bar");
  const doneView = h("div.done", { hidden: true });
  const stage = h("div.card-stage", {}, frame.element, doneView);

  root.replaceChildren(
    h(
      "div.study",
      {},
      h(
        "div.study-bar",
        {},
        h("button.ghost", { type: "button", textContent: "← Decks", title: "Back to decks (Esc)", onclick: onExit }),
        h("div.study-title", { textContent: deck.split("::").join(" › ") }),
        counts,
        h("div.study-actions", {}, undoBtn, suspendBtn),
      ),
      stage,
      bar,
    ),
  );

  const renderCounts = (c: DeckCounts, active?: CardRecord) => {
    const state = active?.sched.state;
    const cell = (cls: string, n: number, on: boolean) => h(`span.${cls}${on ? ".active" : ""}`, { textContent: String(n) });
    counts.replaceChildren(
      cell("new", c.new, state === 0),
      h("span.sep", { textContent: "+" }),
      cell("learn", c.learn, state === 1 || state === 3),
      h("span.sep", { textContent: "+" }),
      cell("review", c.review, state === 2),
    );
  };

  const showQuestionBar = () => {
    bar.replaceChildren(
      h("button.primary.wide", { type: "button", onclick: () => void showAnswer() }, "Show answer", h("kbd", { textContent: "Space" })),
    );
  };

  const showGradeBar = (card: CardRecord) => {
    const now = Date.now();
    const dues = preview(card.sched, settings, new Date(now));
    bar.replaceChildren(
      ...GRADES.map(({ rating, label, key }) =>
        h(
          `button.grade.grade-${label.toLowerCase()}`,
          { type: "button", onclick: () => void grade(rating) },
          h("span.ivl", { textContent: formatInterval(dues.get(rating)! - now) }),
          h("span.label", { textContent: label }),
          h("kbd", { textContent: key }),
        ),
      ),
    );
  };

  async function load(skip?: string) {
    clearTimeout(refreshTimer);
    side = "loading";
    const q = await nextCard(deck, settings, skip);
    renderCounts(q.counts, q.card);
    undoBtn.disabled = undoStack.length === 0;
    if (!q.card) return showDone(q.nextDue);

    const note = await db.notes.get(q.card.noteGuid);
    const notetype = note && (await db.notetypes.get(note.notetypeId));
    if (!note || !notetype) {
      toast("Skipping a card whose note is missing", "error");
      await setSuspended(q.card, true);
      return load();
    }
    current = { card: q.card, note, notetype, css: await inlineMedia(notetype.css, mediaLookup) };
    frame.typed = "";
    const r = renderCard(notetype, note, q.card.ord, q.card.deck);
    doneView.hidden = true;
    frame.element.hidden = false;
    await frame.show(await inlineMedia(r.question, mediaLookup), current.css, q.card.ord);
    lastShown = q.card.id;
    side = "question";
    suspendBtn.disabled = false;
    showQuestionBar();
    frame.focus();
  }

  function showDone(nextDue?: number) {
    side = "done";
    current = undefined;
    suspendBtn.disabled = true;
    frame.element.hidden = true;
    doneView.hidden = false;
    const wait = nextDue ? nextDue - Date.now() : 0;
    doneView.replaceChildren(
      h("h2", { textContent: "Congratulations!" }),
      h("p", { textContent: "You have finished this deck for now." }),
      nextDue ? h("p.muted", { textContent: `More learning cards are due in ${formatInterval(wait)}.` }) : "",
      h("button.primary", { type: "button", textContent: "Back to decks", onclick: onExit }),
    );
    bar.replaceChildren();
    if (nextDue) refreshTimer = window.setTimeout(() => void load(), Math.max(1000, wait - 20 * 60_000));
  }

  async function showAnswer() {
    if (side !== "question" || !current) return;
    side = "loading";
    const { card, note, notetype, css } = current;
    const r = renderCard(notetype, note, card.ord, card.deck, frame.typed);
    await frame.show(await inlineMedia(r.answer, mediaLookup), css, card.ord, true);
    side = "answer";
    showGradeBar(card);
    frame.focus();
  }

  async function grade(rating: Grade) {
    if (side !== "answer" || !current) return;
    side = "loading";
    undoStack = [...undoStack.slice(-19), await recordAnswer(current.card, rating, settings)];
    // Avoid showing the same card twice in a row when other cards are waiting.
    await load(lastShown);
  }

  async function doUndo() {
    const entry = undoStack.pop();
    if (!entry || side === "loading") return;
    await undo(entry);
    toast("Undid last answer");
    await load();
  }

  async function doSuspend() {
    if (!current || side === "loading") return;
    await setSuspended(current.card, true);
    toast("Card suspended");
    await load();
  }

  function handleKey(key: string) {
    if (key === "Escape") return onExit();
    if (key === "z" || key === "Z") return void doUndo();
    if (key === "@") return void doSuspend();
    if (side === "question" && (key === " " || key === "Enter")) return void showAnswer();
    if (side === "answer") {
      if (key === " " || key === "Enter") return void grade(GRADES[2].rating);
      const g = GRADES.find((x) => x.key === key);
      if (g) void grade(g.rating);
    }
  }

  const onDocKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("dialog, input, textarea, select")) return;
    if (t.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    if (["Escape", " ", "Enter", "1", "2", "3", "4", "z", "Z", "@"].includes(e.key)) {
      e.preventDefault();
      handleKey(e.key);
    }
  };
  document.addEventListener("keydown", onDocKey);
  void load();

  return () => {
    clearTimeout(refreshTimer);
    document.removeEventListener("keydown", onDocKey);
    frame.destroy();
  };
}
