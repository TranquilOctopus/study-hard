import { describe, expect, it } from "vitest";
import { readAnkiPackage } from "../src/importers/apkg";
import { renderCard } from "../src/render/template";
import { fixture, loadSql } from "./helpers";

describe.each(["math.apkg", "math-legacy.apkg", "math.colpkg"])("readAnkiPackage(%s)", (file) => {
  it("reads notetypes, notes, cards, decks and media", async () => {
    const bundle = readAnkiPackage(fixture(file), await loadSql());

    const byName = new Map(bundle.notetypes.map((n) => [n.name, n]));
    expect(byName.get("Basic")?.fields).toEqual(["Front", "Back"]);
    expect(byName.get("Basic (and reversed card)")?.templates.map((t) => t.name)).toEqual(["Card 1", "Card 2"]);
    expect(byName.get("Cloze")?.kind).toBe("cloze");
    expect(byName.get("Basic")?.templates[0].qfmt).toContain("{{Front}}");
    expect(byName.get("Basic")?.css).toContain(".card");

    expect(bundle.notes).toHaveLength(3);
    expect(bundle.cards).toHaveLength(5);
    expect(new Set(bundle.cards.map((c) => c.deck))).toEqual(new Set(["Math::Algebra", "Math::Calculus"]));

    const quad = bundle.notes.find((n) => n.tags.includes("quadratic"))!;
    expect(quad.fields[0]).toBe("Solve \\(x^2 = 4\\)");
    const reviewed = bundle.cards.find((c) => c.noteGuid === quad.guid)!;
    expect(reviewed.sched?.state).toBe(2);
    expect(reviewed.sched?.scheduledDays).toBe(10);
    expect(reviewed.sched!.due).toBeGreaterThan(Date.UTC(2026, 0, 1));

    expect([...bundle.media.keys()]).toEqual(["dot.png"]);
    expect(bundle.media.get("dot.png")!.slice(1, 4)).toEqual(new TextEncoder().encode("PNG"));
  });

  it("renders the cloze note with MathJax intact", async () => {
    const bundle = readAnkiPackage(fixture(file), await loadSql());
    const cloze = bundle.notetypes.find((n) => n.kind === "cloze")!;
    const note = bundle.notes.find((n) => n.notetypeId === cloze.id)!;
    const card2 = renderCard(cloze, note, 1, "Math::Calculus");
    expect(card2.question).toContain("\\(x^n\\)");
    expect(card2.question).toContain("[power rule]");
    expect(card2.answer).toContain('<span class="cloze" data-ordinal="2">\\(n x^{n-1}\\)</span>');
  });
});
