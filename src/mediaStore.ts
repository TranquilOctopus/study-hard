import { db } from "./db";
import type { MediaRecord } from "./model";

type Fetcher = (rec: MediaRecord) => Promise<Blob | undefined>;
let fetcher: Fetcher | undefined;

/** Lets sync download files that were added on another device. */
export function setMediaFetcher(fn: Fetcher | undefined): void {
  fetcher = fn;
}

/** A media file's content, downloading it first if only its metadata synced. */
export async function getMediaBlob(name: string): Promise<Blob | undefined> {
  const rec = await db.media.get(name);
  if (!rec) return undefined;
  if (rec.data) return rec.data;
  try {
    return await fetcher?.(rec);
  } catch (err) {
    console.warn(`Could not download ${name}`, err);
    return undefined;
  }
}
