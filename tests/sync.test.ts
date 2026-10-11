import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { StudyDB } from "../src/db";
import type { CardRecord } from "../src/model";
import { AccountMismatchError, fetchMedia, sync, type Remote, type RemoteRow, type RowWrite } from "../src/sync/engine";
import { track } from "../src/sync/tracking";
import { newSchedule } from "../src/scheduler";

/** In-memory stand-in for Supabase, shared by several simulated devices. */
class Server {
  tables = new Map<string, Map<string, RemoteRow & { user: string }>>();
  files = new Map<string, Blob>();
  clock = Date.UTC(2026, 9, 1);

  remote(userId: string): Remote {
    const server = this;
    return {
      userId,
      async upsert(table: string, rows: RowWrite[]) {
        const t = server.tables.get(table) ?? new Map();
        server.tables.set(table, t);
        for (const r of rows) {
          // Like Postgres jsonb, don't preserve the client's key order.
          const data = r.data && typeof r.data === "object" ? Object.fromEntries(Object.entries(structuredClone(r.data)).reverse()) : r.data;
          t.set(`${userId}/${r.id}`, { ...r, data, user: userId, updated_at: new Date(++server.clock).toISOString() });
        }
      },
      async changes(table: string, since: string | undefined, offset: number, limit: number) {
        return [...(server.tables.get(table)?.values() ?? [])]
          .filter((r) => r.user === userId && (!since || r.updated_at > since))
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
          .slice(offset, offset + limit)
          .map(({ user: _user, ...r }) => structuredClone(r));
      },
      async uploadMedia(path: string, data: Blob) {
        server.files.set(path, data);
      },
      async downloadMedia(path: string) {
        const f = server.files.get(path);
        if (!f) throw new Error(`missing ${path}`);
        return f;
      },
    };
  }
}

let n = 0;
const device = () => new StudyDB(`device-${++n}`);

const card = (id: string, deck = "Math"): CardRecord => ({
  id,
  noteGuid: id.split(":")[0],
  ord: 0,
  deck,
  position: 0,
  suspended: false,
  sched: newSchedule(new Date(Date.UTC(2026, 9, 1))),
});

async function addCard(db: StudyDB, c: CardRecord) {
  await db.transaction("rw", [db.cards, db.notes, db.outbox], async () => {
    await db.notes.put({ guid: c.noteGuid, notetypeId: "builtin-basic", fields: ["\\(x\\)", "y"], tags: [] });
    await db.cards.put(c);
    await track(db, "notes", [c.noteGuid]);
    await track(db, "cards", [c.id]);
  });
}

async function editCard(db: StudyDB, id: string, changes: Partial<CardRecord>) {
  await db.transaction("rw", [db.cards, db.outbox], async () => {
    await db.cards.update(id, changes);
    await track(db, "cards", [id]);
  });
}

describe("sync engine", () => {
  let server: Server;
  beforeEach(() => {
    server = new Server();
  });

  it("copies one device's collection to another", async () => {
    const a = device();
    const b = device();
    await addCard(a, card("n1:0"));
    await addCard(a, card("n2:0", "Physics"));
    const remote = server.remote("u1");

    // Our own rows come back on the next pull but don't count as changes.
    expect(await sync(a, remote)).toEqual({ pushed: 4, pulled: 0 });
    expect(await sync(a, remote)).toEqual({ pushed: 0, pulled: 0 });
    expect(await a.outbox.count()).toBe(0);
    expect((await sync(b, remote)).pulled).toBe(4);
    expect(await b.cards.toArray()).toEqual(await a.cards.toArray());
    expect(await b.notes.toArray()).toEqual(await a.notes.toArray());
    // Pulling what we already have is a no-op.
    expect((await sync(b, remote)).pulled).toBe(0);
  });

  it("propagates edits, reviews and deletions both ways", async () => {
    const a = device();
    const b = device();
    const remote = server.remote("u1");
    await addCard(a, card("n1:0"));
    await sync(a, remote);
    await sync(b, remote);

    await editCard(b, "n1:0", { suspended: true });
    await b.transaction("rw", [b.revlog, b.outbox], async () => {
      await b.revlog.add({ id: "r1", cardId: "n1:0", deck: "Math", time: 1, rating: 3, prevState: 0 });
      await track(b, "revlog", ["r1"]);
    });
    await sync(b, remote);
    await sync(a, remote);
    expect((await a.cards.get("n1:0"))?.suspended).toBe(true);
    expect(await a.revlog.count()).toBe(1);

    await a.transaction("rw", [a.cards, a.outbox], async () => {
      await a.cards.delete("n1:0");
      await track(a, "cards", ["n1:0"]);
    });
    await sync(a, remote);
    await sync(b, remote);
    expect(await b.cards.get("n1:0")).toBeUndefined();
  });

  it("never overwrites a local change that hasn't been pushed yet", async () => {
    const a = device();
    const b = device();
    const remote = server.remote("u1");
    await addCard(a, card("n1:0"));
    await sync(a, remote);
    await sync(b, remote);

    await editCard(a, "n1:0", { deck: "From A" });
    await editCard(b, "n1:0", { deck: "From B" });
    await sync(a, remote);
    // B pushes its own pending change first, so last writer (B) wins everywhere.
    await sync(b, remote);
    await sync(a, remote);
    expect((await a.cards.get("n1:0"))?.deck).toBe("From B");
    expect((await b.cards.get("n1:0"))?.deck).toBe("From B");
  });

  it("only clears outbox entries that didn't change during the push", async () => {
    const a = device();
    await addCard(a, card("n1:0"));
    const remote = server.remote("u1");
    let edited = false;
    const slow: Remote = {
      ...remote,
      upsert: async (table, rows) => {
        await remote.upsert(table, rows);
        if (table === "cards" && !edited) {
          edited = true;
          await editCard(a, "n1:0", { deck: "Edited mid-push" });
        }
      },
    };
    await sync(a, slow);
    // The re-edited card was pushed again in a second round.
    expect(await a.outbox.count()).toBe(0);
    expect(server.tables.get("cards")?.get("u1/n1:0")?.data).toMatchObject({ deck: "Edited mid-push" });
    const b = device();
    await sync(b, remote);
    expect((await b.cards.get("n1:0"))?.deck).toBe("Edited mid-push");
  });

  it("uploads media and downloads it lazily on other devices", async () => {
    const a = device();
    const b = device();
    const remote = server.remote("u1");
    await a.transaction("rw", [a.media, a.outbox], async () => {
      await a.media.put({ name: "graph.png", data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), size: 3 });
      await track(a, "media", ["graph.png"]);
    });
    await sync(a, remote);
    expect(server.files.size).toBe(1);
    expect([...server.files.keys()][0]).toMatch(/^u1\/[0-9a-f]{64}$/);

    await sync(b, remote);
    const placeholder = (await b.media.get("graph.png"))!;
    expect(placeholder.data).toBeUndefined();
    const blob = await fetchMedia(b, remote, placeholder);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await b.media.get("graph.png"))?.data).toBeDefined();
    // The downloaded copy is not re-uploaded.
    expect(await b.outbox.count()).toBe(0);
  });

  it("keeps accounts apart", async () => {
    const a = device();
    await addCard(a, card("n1:0"));
    await sync(a, server.remote("u1"));
    await expect(sync(a, server.remote("u2"))).rejects.toBeInstanceOf(AccountMismatchError);

    const other = device();
    await sync(other, server.remote("u2"));
    expect(await other.cards.count()).toBe(0);
  });

  it("pages through large pulls", async () => {
    const a = device();
    const b = device();
    const remote = server.remote("u1");
    await a.transaction("rw", [a.cards, a.outbox], async () => {
      const cards = Array.from({ length: 2500 }, (_, i) => card(`n${i}:0`));
      await a.cards.bulkPut(cards);
      await track(a, "cards", cards.map((c) => c.id));
    });
    expect((await sync(a, remote)).pushed).toBe(2500);
    expect((await sync(b, remote)).pulled).toBe(2500);
    expect(await b.cards.count()).toBe(2500);
  }, 60_000);
});

describe("database upgrade", () => {
  it("moves v1 reviews to revlog and queues existing data for upload", async () => {
    const { default: Dexie } = await import("dexie");
    const old = new Dexie("legacy-device");
    old.version(1).stores({ notetypes: "id", notes: "guid, notetypeId", cards: "id, noteGuid, deck", media: "name", reviews: "++id, cardId, deck, time" });
    await old.table("cards").put(card("n1:0"));
    await old.table("reviews").add({ cardId: "n1:0", deck: "Math", time: 5, rating: 3, prevState: 0 });
    old.close();

    const upgraded = new StudyDB("legacy-device");
    const [review] = await upgraded.revlog.toArray();
    expect(review.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(review.time).toBe(5);
    expect((await upgraded.outbox.toArray()).map((e) => e.key).sort()).toEqual(["cards\x1fn1:0", `revlog\x1f${review.id}`]);
  });
});
