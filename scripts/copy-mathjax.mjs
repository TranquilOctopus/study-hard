// Copies the self-contained MathJax SVG bundle into public/ so equations
// render fully offline (no CDN requests).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve("mathjax/package.json")), "es5", "tex-svg-full.js");
const outDir = join(import.meta.dirname, "..", "public", "mathjax");
mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, "tex-svg-full.js"));
