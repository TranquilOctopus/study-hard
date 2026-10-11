import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);

export const loadSql = () =>
  initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });

export const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
