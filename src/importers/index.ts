// Detects a package's format and dispatches to the right reader.

import { unzipSync } from "fflate";
import type { SqlJsStatic } from "sql.js";
import type { ImportBundle } from "../model";
import { readAnkiPackage } from "./apkg";
import { findDeckJson, readCrowdAnki } from "./crowdanki";
import { readDelimited } from "./csv";

export interface InputFile {
  /** Path relative to the picked folder, or just the file name. */
  path: string;
  data: Uint8Array;
}

export type SqlLoader = () => Promise<SqlJsStatic>;

const isZip = (d: Uint8Array) => d[0] === 0x50 && d[1] === 0x4b;

export async function readPackage(files: InputFile[], loadSql: SqlLoader): Promise<ImportBundle> {
  if (files.length === 1) {
    const { path, data } = files[0];
    if (/\.(apkg|colpkg)$/i.test(path)) return readAnkiPackage(data, await loadSql());
    if (isZip(data)) {
      const entries = new Map(Object.entries(unzipSync(data)));
      if (entries.has("collection.anki2") || entries.has("collection.anki21") || entries.has("collection.anki21b")) {
        return readAnkiPackage(data, await loadSql());
      }
      if (findDeckJson(entries)) return readCrowdAnki(entries);
      throw new Error(`${path}: zip contains neither an Anki collection nor a CrowdAnki deck.json`);
    }
    if (/\.json$/i.test(path)) return readCrowdAnki(new Map([[path, data]]));
    if (/\.(csv|tsv|txt)$/i.test(path)) {
      return readDelimited(new TextDecoder().decode(data), path.split("/").pop()!);
    }
    throw new Error(`${path}: unsupported file type`);
  }
  // A picked folder: expect a CrowdAnki export.
  const map = new Map(files.map((f) => [f.path, f.data]));
  if (findDeckJson(map)) return readCrowdAnki(map);
  throw new Error("The selected folder has no CrowdAnki deck.json");
}
