import { describe, expect, it } from "vitest";
import { BASIC, CLOZE } from "../src/importers/builtin";
import type { Note, Notetype } from "../src/model";
import { clozeNumbers, renderCloze } from "../src/render/cloze";
import { cardOrdinals, convertLatex, renderCard } from "../src/render/template";

const note = (notetypeId: string, fields: string[], tags: string[] = []): Note => ({
  guid: "g",
  notetypeId,
  fields,
  tags,
});

const REVERSIBLE: Notetype = {
  id: "rev",
  name: "Optional reverse",
  kind: "normal",
  css: "",
  fields: ["Front", "Back", "Add Reverse"],
  templates: [
    { name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" },
    { name: "Card 2", qfmt: "{{#Add Reverse}}{{Back}}{{/Add Reverse}}", afmt: "{{FrontSide}}<hr id=answer>{{Front}}" },
  ],
};

describe("renderCard", () => {
  it("substitutes fields and FrontSide", () => {
    const r = renderCard(BASIC, note(BASIC.id, ["\\(a^2\\)", "b"]), 0, "D");
    expect(r.question).toBe("\\(a^2\\)");
    expect(r.answer).toBe("\\(a^2\\)\n\n<hr id=answer>\n\nb");
  });

  it("handles conditionals, negation and special fields", () => {
    const nt: Notetype = {
      ...BASIC,
      templates: [{ name: "C", qfmt: "{{#Back}}has{{/Back}}{{^Back}}none{{/Back}} {{Deck}}/{{Subdeck}} {{Tags}} {{Card}}", afmt: "" }],
    };
    expect(renderCard(nt, note(nt.id, ["x", " <br> "], ["t1", "t2"]), 0, "A::B").question).toBe("none A::B/B t1 t2 C");
    expect(renderCard(nt, note(nt.id, ["x", "y"]), 0, "A").question.startsWith("has")).toBe(true);
  });

  it("applies filters right to left", () => {
    const nt: Notetype = { ...BASIC, templates: [{ name: "C", qfmt: "{{text:Front}}|{{furigana:Back}}|{{kana:Back}}", afmt: "" }] };
    const r = renderCard(nt, note(nt.id, ["<b>bold</b> &amp; co", "漢字[かんじ]"]), 0, "D");
    expect(r.question).toBe("bold & co|<ruby><rb>漢字</rb><rt>かんじ</rt></ruby>|かんじ");
  });

  it("reports unknown fields like Anki", () => {
    const nt: Notetype = { ...BASIC, templates: [{ name: "C", qfmt: "{{Nope}}", afmt: "" }] };
    expect(renderCard(nt, note(nt.id, ["a", "b"]), 0, "D").question).toBe("{unknown field Nope}");
  });

  it("renders type-in answers", () => {
    const nt: Notetype = {
      ...BASIC,
      templates: [{ name: "C", qfmt: "{{Front}} {{type:Back}}", afmt: "{{FrontSide}}<hr id=answer>{{type:Back}}" }],
    };
    const n = note(nt.id, ["Q", "<i>Paris</i>"]);
    const q = renderCard(nt, n, 0, "D");
    expect(q.question).toContain('<input type="text" id="typeans"');
    expect(q.typeAnswer).toBe("Paris");
    const right = renderCard(nt, n, 0, "D", "Paris");
    expect(right.answer).toContain('class="typeGood">Paris');
    expect(right.answer).not.toContain('id="typeans"');
    expect(renderCard(nt, n, 0, "D", "Lyon").answer).toContain('class="typeBad">Lyon');
  });

  it("converts Anki LaTeX tags to MathJax delimiters", () => {
    expect(convertLatex("[$]x^2[/$] and [$$]\\int f[/$$]")).toBe("\\(x^2\\) and \\[\\int f\\]");
    expect(convertLatex("[latex]Let $x$ be $$y$$[/latex]")).toBe("Let \\(x\\) be \\[y\\]");
  });
});

describe("cloze", () => {
  it("renders active, inactive and hinted clozes", () => {
    const text = "{{c1::Paris}} is in {{c2::France::country}}";
    expect(renderCloze(text, 1, "question")).toBe(
      '<span class="cloze" data-cloze="Paris" data-ordinal="1">[...]</span> is in ' +
        '<span class="cloze-inactive" data-ordinal="2">France</span>',
    );
    expect(renderCloze(text, 2, "question")).toContain(">[country]</span>");
    expect(renderCloze(text, 2, "answer")).toContain('<span class="cloze" data-ordinal="2">France</span>');
  });

  it("supports nested clozes and multiple ordinals", () => {
    const text = "{{c1::outer {{c2::inner}} text}} {{c1,3::both}}";
    expect([...clozeNumbers(text)].sort()).toEqual([1, 2, 3]);
    expect(renderCloze(text, 2, "question")).toContain("outer <span class=\"cloze\"");
    expect(renderCloze(text, 1, "answer")).toContain("outer <span class=\"cloze-inactive\" data-ordinal=\"2\">inner</span> text");
    expect(renderCloze(text, 3, "question")).toContain("[...]");
  });

  it("keeps clozes inside MathJax as valid TeX", () => {
    const text = "\\(x = {{c1::2}} + {{c2::y}}\\)";
    expect(renderCloze(text, 1, "question")).toBe("\\(x = \\boxed{\\,?\\,} + y\\)");
    expect(renderCloze(text, 1, "answer")).toBe("\\(x = \\boxed{2} + y\\)");
  });

  it("leaves unterminated clozes as text", () => {
    expect(renderCloze("{{c1::oops", 1, "question")).toBe("{{c1::oops");
  });
});

describe("cardOrdinals", () => {
  it("only generates cards whose question uses a non-empty field", () => {
    expect(cardOrdinals(REVERSIBLE, note("rev", ["a", "b", ""]))).toEqual([0]);
    expect(cardOrdinals(REVERSIBLE, note("rev", ["a", "b", "y"]))).toEqual([0, 1]);
  });

  it("generates one card per cloze number", () => {
    expect(cardOrdinals(CLOZE, note(CLOZE.id, ["{{c1::a}} {{c3::b}}", ""]))).toEqual([0, 2]);
  });
});
