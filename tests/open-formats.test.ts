import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readPackage } from "../src/importers";
import { buildCrowdAnki, readCrowdAnki } from "../src/importers/crowdanki";
import { parseDelimited, readDelimited } from "../src/importers/csv";
import { inlineMedia, referencedMedia } from "../src/render/media";
import { loadSql } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);

describe("CSV / TSV", () => {
  it("parses quoted fields with separators and newlines", () => {
    expect(parseDelimited('a,"b, c"\n"multi\nline","say ""hi"""\n', ",")).toEqual([
      ["a", "b, c"],
      ["multi\nline", 'say "hi"'],
    ]);
  });

  it("imports basic notes, escaping plain text so math survives", () => {
    const b = readDelimited("Front\tBack\n\\(a < b\\)\ttrue\n", "Inequalities.tsv");
    expect(b.notes[1].fields[0]).toBe("\\(a &lt; b\\)");
    expect(b.cards.map((c) => c.deck)).toEqual(["Inequalities", "Inequalities"]);
    expect(b.notetypes.map((n) => n.name)).toEqual(["Basic"]);
  });

  it("honours Anki text-export headers and detects cloze", () => {
    const text = [
      "#separator:Semicolon",
      "#html:true",
      "#deck:Physics",
      "#tags column:3",
      "{{c1::\\(F = ma\\)}} is Newton's second law;<b>extra</b>;mechanics newton",
    ].join("\n");
    const b = readDelimited(text, "x.csv");
    expect(b.notetypes[0].kind).toBe("cloze");
    expect(b.notes[0]).toMatchObject({ fields: ["{{c1::\\(F = ma\\)}} is Newton's second law", "<b>extra</b>"], tags: ["mechanics", "newton"] });
    expect(b.cards).toMatchObject([{ deck: "Physics", ord: 0 }]);
  });

  it("gives re-imported rows the same GUID", () => {
    expect(readDelimited("q,a", "d.csv").notes[0].guid).toBe(readDelimited("q,changed", "d.csv").notes[0].guid);
  });
});

describe("CrowdAnki", () => {
  const deck = {
    __type__: "Deck",
    name: "Linear Algebra",
    media_files: ["m.png"],
    note_models: [
      {
        crowdanki_uuid: "model-1",
        name: "Basic",
        type: 0,
        css: ".card{}",
        flds: [{ name: "Front", ord: 0 }, { name: "Back", ord: 1 }],
        tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{Back}}" }],
      },
    ],
    notes: [{ guid: "n1", note_model_uuid: "model-1", fields: ["\\(\\det A\\)", '<img src="m.png">'], tags: ["det"] }],
    children: [
      {
        name: "Linear Algebra::Eigen",
        notes: [{ guid: "n2", note_model_uuid: "model-1", fields: ["\\(Av = \\lambda v\\)", "eigen"], tags: [] }],
      },
    ],
  };

  it("reads a zipped deck folder with media and subdecks", async () => {
    const zip = zipSync({
      "Linear_Algebra/deck.json": enc(JSON.stringify(deck)),
      "Linear_Algebra/media/m.png": new Uint8Array([1, 2, 3]),
    });
    const b = await readPackage([{ path: "la.zip", data: zip }], loadSql);
    expect(b.notes.map((n) => n.guid)).toEqual(["n1", "n2"]);
    expect(b.cards.map((c) => c.deck)).toEqual(["Linear Algebra", "Linear Algebra::Eigen"]);
    expect([...b.media.keys()]).toEqual(["m.png"]);
  });

  it("round-trips through export", () => {
    const first = readCrowdAnki(new Map([["deck.json", enc(JSON.stringify(deck))]]));
    const exported = buildCrowdAnki({
      rootDeck: "Linear Algebra",
      notetypes: first.notetypes,
      notes: first.notes.map((note, i) => ({ note, deck: first.cards[i].deck })),
      mediaNames: ["m.png"],
    });
    const again = readCrowdAnki(new Map([["x/deck.json", enc(JSON.stringify(exported))]]));
    expect(again.notes).toEqual(first.notes);
    expect(again.notetypes).toEqual(first.notetypes);
    expect(again.cards).toEqual(first.cards);
  });
});

describe("media", () => {
  it("finds and inlines local references only", async () => {
    const html = `<img src="a b.png"><img src='https://x/y.png'>[sound:s.mp3]<style>@font-face{src:url("_f.ttf")}</style>`;
    expect([...referencedMedia(html)].sort()).toEqual(["_f.ttf", "a b.png", "s.mp3"]);
    const out = await inlineMedia(html, async (n) => (n === "https://x/y.png" ? "BAD" : `data:${n}`));
    expect(out).toContain('src="data:a b.png"');
    expect(out).toContain("src='https://x/y.png'");
    expect(out).toContain('<audio class="sound" controls preload="auto" src="data:s.mp3"></audio>');
    expect(out).toContain('url("data:_f.ttf")');
  });
});
