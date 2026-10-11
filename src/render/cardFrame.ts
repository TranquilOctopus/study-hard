// Cards render inside a sandboxed iframe (scripts allowed, but an opaque
// origin), so card HTML/JS from downloaded decks can't touch the app or its
// data. MathJax is loaded once into the frame and re-typesets each card.

const FRAME_SCRIPT = String.raw`
const qa = document.getElementById("qa");
const style = document.getElementById("card-css");
const post = (msg) => parent.postMessage(msg, "*");

function runScripts(root) {
  for (const old of root.querySelectorAll("script")) {
    const s = document.createElement("script");
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
}

window.addEventListener("message", async (e) => {
  if (e.source !== parent || !e.data || e.data.type !== "render") return;
  const { id, html, css, bodyClass, scrollToAnswer } = e.data;
  try {
    await MathJax.startup.promise;
    MathJax.typesetClear([qa]);
  } catch (err) {}
  style.textContent = css;
  document.body.className = bodyClass;
  qa.innerHTML = html;
  try { runScripts(qa); } catch (err) { console.error(err); }
  const input = document.getElementById("typeans");
  if (input) {
    input.addEventListener("input", () => post({ type: "typed", value: input.value }));
    input.focus();
  }
  try { await MathJax.typesetPromise([qa]); } catch (err) { console.error(err); }
  const answer = document.getElementById("answer");
  if (scrollToAnswer && answer) answer.scrollIntoView({ block: "start" });
  else window.scrollTo(0, 0);
  post({ type: "rendered", id });
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const editing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (editing && e.key !== "Enter" && e.key !== "Escape") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  post({ type: "key", key: e.key });
});

post({ type: "ready" });
`;

const BASE_CSS = `
html, body { margin: 0; min-height: 100%; }
body { padding: 20px; box-sizing: border-box; overflow-wrap: break-word; }
img, video { max-width: 100%; height: auto; }
#typeans { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; margin-top: 8px; }
.typeGood { background: #c9f7c9; color: #000; }
.typeBad { background: #f7c9c9; color: #000; }
.typeMissed { background: #e5e5e5; color: #000; }
.cloze-inactive { }
mjx-container[display="true"] { overflow-x: auto; overflow-y: hidden; max-width: 100%; }
`;

function frameDocument(mathjaxUrl: string): string {
  const config = {
    tex: {
      inlineMath: [["\\(", "\\)"]],
      displayMath: [["\\[", "\\]"]],
      processEscapes: true,
      packages: { "[+]": ["mhchem", "noerrors", "noundefined"] },
    },
    // "local" keeps every equation self-contained, so swapping card HTML never
    // orphans shared glyph definitions.
    svg: { fontCache: "local" },
    startup: { typeset: false },
    options: { ignoreHtmlClass: "tex2jax_ignore", processHtmlClass: "tex2jax_process", enableMenu: false },
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style><style id="card-css"></style>
<script>window.MathJax = ${JSON.stringify(config)};</script>
<script src="${mathjaxUrl}"></script>
</head><body class="card"><div id="qa"></div><script>${FRAME_SCRIPT}</script></body></html>`;
}

export interface CardFrameEvents {
  onKey(key: string): void;
}

export class CardFrame {
  readonly element: HTMLIFrameElement;
  private ready: Promise<void>;
  private pending = new Map<number, () => void>();
  private nextId = 1;
  typed = "";

  constructor(events: CardFrameEvents) {
    this.element = document.createElement("iframe");
    this.element.className = "card-frame";
    this.element.title = "Card";
    this.element.setAttribute("sandbox", "allow-scripts");
    const mathjaxUrl = new URL("mathjax/tex-svg-full.js", document.baseURI).href;
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));

    this.onMessage = (e: MessageEvent) => {
      if (e.source !== this.element.contentWindow || !e.data) return;
      const msg = e.data as { type: string; id?: number; key?: string; value?: string };
      if (msg.type === "ready") markReady();
      else if (msg.type === "rendered") {
        this.pending.get(msg.id!)?.();
        this.pending.delete(msg.id!);
      } else if (msg.type === "typed") this.typed = msg.value ?? "";
      else if (msg.type === "key") events.onKey(msg.key ?? "");
    };
    window.addEventListener("message", this.onMessage);
    this.element.srcdoc = frameDocument(mathjaxUrl);
  }

  private onMessage: (e: MessageEvent) => void;

  async show(html: string, css: string, cardOrd: number, scrollToAnswer = false): Promise<void> {
    await this.ready;
    const id = this.nextId++;
    const night = document.documentElement.dataset.theme === "dark" ||
      (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    const bodyClass = `card card${cardOrd + 1}${night ? " nightMode night_mode" : ""}`;
    const done = new Promise<void>((r) => this.pending.set(id, r));
    this.element.contentWindow!.postMessage({ type: "render", id, html, css, bodyClass, scrollToAnswer }, "*");
    await done;
  }

  focus(): void {
    this.element.contentWindow?.focus();
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    this.element.remove();
  }
}
