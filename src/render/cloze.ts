// Cloze deletion parsing and rendering, including nested clozes and clozes
// placed inside MathJax expressions (e.g. `\(x = {{c1::2}}\)`).

import { escapeHtml, stripHtml } from "./html";

type ClozeNode = string | Cloze;

interface Cloze {
  ords: number[];
  children: ClozeNode[];
  hint?: string;
  inMath: boolean;
}

const OPEN_RE = /\{\{c(\d+(?:,\d+)*)::/y;

/** Character ranges covered by \( .. \) and \[ .. \] MathJax delimiters. */
function mathRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
  for (let m; (m = re.exec(text)); ) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function parse(text: string): ClozeNode[] {
  const math = mathRanges(text);
  const inMath = (i: number) => math.some(([a, b]) => i > a && i < b);
  const root: ClozeNode[] = [];
  const stack: Cloze[] = [];
  let buf = "";
  const current = () => (stack.length ? stack[stack.length - 1].children : root);
  const flush = () => {
    if (buf) current().push(buf);
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    OPEN_RE.lastIndex = i;
    const open = OPEN_RE.exec(text);
    if (open) {
      flush();
      const cloze: Cloze = {
        ords: open[1].split(",").map(Number),
        children: [],
        inMath: inMath(i),
      };
      current().push(cloze);
      stack.push(cloze);
      i += open[0].length;
    } else if (stack.length && text.startsWith("}}", i)) {
      flush();
      const cloze = stack.pop()!;
      splitHint(cloze);
      i += 2;
    } else {
      buf += text[i++];
    }
  }
  flush();
  // Unterminated clozes are kept as literal text, as Anki does.
  while (stack.length) {
    const cloze = stack.pop()!;
    const parent = stack.length ? stack[stack.length - 1].children : root;
    const idx = parent.indexOf(cloze);
    parent.splice(idx, 1, `{{c${cloze.ords.join(",")}::`, ...cloze.children);
  }
  return root;
}

/** Moves anything after the first top-level "::" into the hint. */
function splitHint(cloze: Cloze): void {
  const idx = cloze.children.findIndex((c) => typeof c === "string" && c.includes("::"));
  if (idx < 0) return;
  const node = cloze.children[idx] as string;
  const cut = node.indexOf("::");
  const rest = [node.slice(cut + 2), ...cloze.children.slice(idx + 1)];
  cloze.hint = rest.map(nodeText).join("");
  cloze.children = [...cloze.children.slice(0, idx), node.slice(0, cut)].filter((c) => c !== "");
}

function nodeText(node: ClozeNode): string {
  return typeof node === "string" ? node : node.children.map(nodeText).join("");
}

export function clozeNumbers(text: string): Set<number> {
  const out = new Set<number>();
  const walk = (nodes: ClozeNode[]) => {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      n.ords.forEach((o) => out.add(o));
      walk(n.children);
    }
  };
  walk(parse(text));
  return out;
}

/** Renders cloze `num` (1-based) for the question or answer side. */
export function renderCloze(text: string, num: number, side: "question" | "answer"): string {
  const render = (nodes: ClozeNode[]): string =>
    nodes
      .map((n) => {
        if (typeof n === "string") return n;
        const inner = render(n.children);
        const active = n.ords.includes(num);
        if (!active) {
          return n.inMath ? inner : `<span class="cloze-inactive" data-ordinal="${n.ords.join(",")}">${inner}</span>`;
        }
        if (side === "question") {
          if (n.inMath) return n.hint ? `\\boxed{\\text{${n.hint}}}` : "\\boxed{\\,?\\,}";
          return `<span class="cloze" data-cloze="${escapeHtml(inner)}" data-ordinal="${num}">[${n.hint ?? "..."}]</span>`;
        }
        if (n.inMath) return `\\boxed{${inner}}`;
        return `<span class="cloze" data-ordinal="${num}">${inner}</span>`;
      })
      .join("");
  return render(parse(text));
}

/** The text hidden by cloze `num`, used by `cloze-only:` and `type:cloze:`. */
export function clozeAnswers(text: string, num: number): string[] {
  const out: string[] = [];
  const walk = (nodes: ClozeNode[]) => {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n.ords.includes(num)) out.push(n.children.map(nodeText).join(""));
      else walk(n.children);
    }
  };
  walk(parse(text));
  return out;
}

export function clozeOnly(text: string, num: number): string {
  return clozeAnswers(text, num).join(", ");
}

export function clozeTypeAnswer(text: string, num: number): string {
  return clozeAnswers(text, num).map(stripHtml).join(", ");
}
