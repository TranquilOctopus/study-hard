// Change tracking: every local write records the changed keys in the outbox
// (inside the same transaction), and sync pushes them later.

import type { StudyDB, SyncTable } from "../db";

let lastSeq = 0;
let listener: (() => void) | undefined;

export const outboxKey = (table: SyncTable, id: string) => `${table}\x1f${id}`;

/** Must be called inside a transaction that includes `db.outbox`. */
export async function track(db: StudyDB, table: SyncTable, ids: Iterable<string>): Promise<void> {
  const entries = [...ids].map((id) => {
    lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
    return { key: outboxKey(table, id), table, id, seq: lastSeq };
  });
  if (!entries.length) return;
  await db.outbox.bulkPut(entries);
  listener?.();
}

/** Called after local changes, e.g. to schedule a sync. */
export function onLocalChange(fn: (() => void) | undefined): void {
  listener = fn;
}
