import "./styles.css";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { readPackage, type InputFile } from "./importers";
import { loadSettings, saveSettings, type Settings } from "./scheduler";
import { deckTree, deleteDeck, exportCrowdAnki, saveBundle } from "./store";
import { download, h, toast } from "./ui/dom";
import { mountStudy } from "./ui/study";

const view = document.getElementById("view")!;
let cleanup: (() => void) | undefined;

let sqlPromise: Promise<SqlJsStatic> | undefined;
const loadSql = () => (sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl }));

// ---------------------------------------------------------------- theme --

type Theme = "system" | "light" | "dark";
const THEME_KEY = "study-hard:theme";

function getTheme(): Theme {
  try {
    return (localStorage.getItem(THEME_KEY) as Theme) || "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not persisted; fine.
  }
}

// --------------------------------------------------------------- import --

async function importFiles(files: InputFile[]): Promise<void> {
  if (!files.length) return;
  const label = files.length === 1 ? files[0].path : "folder";
  toast(`Importing ${label}…`);
  try {
    const bundle = await readPackage(files, loadSql);
    const s = await saveBundle(bundle);
    void navigator.storage?.persist?.();
    const parts = [`${s.notes} notes`, `${s.newCards} new cards`];
    if (s.updatedCards) parts.push(`${s.updatedCards} updated`);
    if (s.media) parts.push(`${s.media} media files`);
    toast(`Imported ${label}: ${parts.join(", ")}`);
  } catch (err) {
    console.error(err);
    toast(`Could not import ${label}: ${(err as Error).message}`, "error");
  }
  if (!cleanup) await showHome();
}

async function importFileList(list: FileList | File[]): Promise<void> {
  const files = [...list];
  const folder = files.some((f) => f.webkitRelativePath);
  const read = async (f: File): Promise<InputFile> => ({
    path: f.webkitRelativePath || f.name,
    data: new Uint8Array(await f.arrayBuffer()),
  });
  if (folder) return importFiles(await Promise.all(files.map(read)));
  for (const f of files) await importFiles([await read(f)]);
}

const ACCEPT = ".apkg,.colpkg,.zip,.json,.csv,.tsv,.txt";

function pickFiles(folder: boolean): void {
  const input = h("input", { type: "file", multiple: true, accept: folder ? "" : ACCEPT });
  if (folder) input.webkitdirectory = true;
  input.onchange = () => input.files && void importFileList(input.files);
  input.click();
}

// ------------------------------------------------------------- settings --

function openSettings(): void {
  const s = loadSettings();
  const num = (name: keyof Settings, label: string, min: number, max: number, step = 1) =>
    h(
      "label.field",
      {},
      h("span", { textContent: label }),
      h("input", { type: "number", name, min: String(min), max: String(max), step: String(step), value: String(s[name]), required: true }),
    );
  const theme = h(
    "select",
    { name: "theme" },
    ...(["system", "light", "dark"] as const).map((t) =>
      h("option", { value: t, textContent: t[0].toUpperCase() + t.slice(1), selected: getTheme() === t }),
    ),
  );
  const cancel = h("button.ghost", { type: "button", textContent: "Cancel" });
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", { textContent: "Settings" }),
    num("newPerDay", "New cards per day", 0, 9999),
    num("reviewsPerDay", "Maximum reviews per day", 0, 99999),
    num("retention", "Desired retention (0.70 – 0.99)", 0.7, 0.99, 0.01),
    num("dayStartHour", "Next day starts at (hour)", 0, 23),
    h("label.field", {}, h("span", { textContent: "Theme" }), theme),
    h(
      "div.dialog-actions",
      {},
      cancel,
      h("button.primary", { type: "submit", value: "save", textContent: "Save" }),
    ),
  );
  const dialog = h("dialog", {}, form);
  cancel.onclick = () => dialog.close();
  form.onsubmit = () => {
    const data = new FormData(form);
    saveSettings({
      newPerDay: Number(data.get("newPerDay")),
      reviewsPerDay: Number(data.get("reviewsPerDay")),
      retention: Number(data.get("retention")),
      dayStartHour: Number(data.get("dayStartHour")),
    });
    applyTheme(data.get("theme") as Theme);
    void showHome();
  };
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}

// ----------------------------------------------------------------- home --

async function showHome(): Promise<void> {
  cleanup?.();
  cleanup = undefined;
  const decks = await deckTree(loadSettings());

  const header = h(
    "div.home-header",
    {},
    h("h1", { textContent: "Decks" }),
    h(
      "div.actions",
      {},
      h("button.primary", { type: "button", textContent: "Import file", onclick: () => pickFiles(false) }),
      h("button", { type: "button", textContent: "Import folder", title: "Import a CrowdAnki deck folder", onclick: () => pickFiles(true) }),
      h("button.ghost", { type: "button", textContent: "Settings", onclick: openSettings }),
    ),
  );

  if (!decks.length) {
    view.replaceChildren(
      header,
      h(
        "div.empty",
        {},
        h("h2", { textContent: "No decks yet" }),
        h("p", { textContent: "Drop a deck anywhere on this page, or use Import. Everything stays in this browser." }),
        h(
          "ul",
          {},
          h("li", {}, h("strong", { textContent: "Anki packages" }), " — .apkg and .colpkg, from any Anki version"),
          h("li", {}, h("strong", { textContent: "CrowdAnki" }), " — deck.json, a zipped deck folder, or the folder itself"),
          h("li", {}, h("strong", { textContent: "CSV / TSV" }), " — Front, Back columns (or cloze text), Anki text-export headers supported"),
        ),
        h("p.muted", {}, "Math in ", h("code", { textContent: "\\( … \\)" }), " and ", h("code", { textContent: "\\[ … \\]" }), " is rendered with MathJax."),
      ),
    );
    return;
  }

  const rows = decks.map((d) => {
    const study = () => showStudy(d.name);
    const exportBtn = h("button.ghost.small", {
      type: "button",
      textContent: "Export",
      title: "Export as a CrowdAnki deck (zip)",
      onclick: async () => {
        try {
          const zip = await exportCrowdAnki(d.name);
          download(zip, `${d.name.replace(/::/g, " - ")}.crowdanki.zip`, "application/zip");
        } catch (err) {
          toast(`Export failed: ${(err as Error).message}`, "error");
        }
      },
    });
    const deleteBtn = h("button.ghost.small.danger", {
      type: "button",
      textContent: "Delete",
      onclick: async () => {
        if (!confirm(`Delete "${d.name}" and all ${d.counts.total} of its cards? This cannot be undone.`)) return;
        await deleteDeck(d.name);
        toast(`Deleted ${d.name}`);
        await showHome();
      },
    });
    const n = (cls: string, v: number) => h(`td.num.${cls}${v ? "" : ".zero"}`, { textContent: String(v) });
    return h(
      "tr",
      {},
      h(
        "td.deck-name",
        { style: `padding-left: calc(12px + ${d.depth} * 20px)` },
        h("button.link", { type: "button", textContent: d.label, title: `Study ${d.name}`, onclick: study }),
      ),
      n("new", d.counts.new),
      n("learn", d.counts.learn),
      n("review", d.counts.review),
      h("td.row-actions", {}, exportBtn, deleteBtn),
    );
  });

  view.replaceChildren(
    header,
    h(
      "table.decks",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { textContent: "Deck" }),
          h("th.num", { textContent: "New" }),
          h("th.num", { textContent: "Learn" }),
          h("th.num", { textContent: "Due" }),
          h("th", { attrs: { "aria-label": "Actions" } }),
        ),
      ),
      h("tbody", {}, ...rows),
    ),
  );
}

function showStudy(deck: string): void {
  cleanup?.();
  cleanup = mountStudy(view, deck, () => void showHome());
}

// ---------------------------------------------------------- drag & drop --

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files.length) void importFileList(e.dataTransfer.files);
});

applyTheme(getTheme());
document.getElementById("home-link")!.addEventListener("click", (e) => {
  e.preventDefault();
  void showHome();
});
void showHome();
