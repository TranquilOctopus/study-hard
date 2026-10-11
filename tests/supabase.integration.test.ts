// Runs the real supabase-js client and SupabaseRemote against PostgREST +
// Postgres with the migration applied. Skipped unless configured:
//
//   STUDY_HARD_POSTGREST_URL=http://localhost:54330 \
//   STUDY_HARD_JWT_SECRET=<PostgREST jwt-secret> npm run test:integration
//
// The database needs tests/sql/supabase_stub.sql, the migration, and the two
// users below in auth.users. Storage isn't part of PostgREST, so media
// uploads are kept in memory here.
import "fake-indexeddb/auto";
import { createHmac } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StudyDB } from "../src/db";
import { sync } from "../src/sync/engine";
import { SupabaseRemote } from "../src/sync/remote";
import { track } from "../src/sync/tracking";
import { newSchedule } from "../src/scheduler";

const POSTGREST = process.env.STUDY_HARD_POSTGREST_URL;
const SECRET = process.env.STUDY_HARD_JWT_SECRET;
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function jwt(sub: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${head}.${body}.${createHmac("sha256", SECRET!).update(`${head}.${body}`).digest("base64url")}`;
}

describe.skipIf(!POSTGREST || !SECRET)("SupabaseRemote against PostgREST", () => {
  // supabase-js talks to <url>/rest/v1; forward that prefix to PostgREST.
  let proxy: Server;
  let url = "";
  const files = new Map<string, Blob>();

  beforeAll(async () => {
    const target = new URL(POSTGREST!);
    proxy = createServer((req, res) => {
      const upstream = request(
        { host: target.hostname, port: target.port, path: req.url!.replace(/^\/rest\/v1/, ""), method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode!, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    // Start from an empty server-side collection for both test users.
    for (const user of [USER_A, USER_B]) {
      const client = createClient(url, "anon-key-not-used", { accessToken: async () => jwt(user) });
      for (const table of ["notetypes", "notes", "cards", "review_log", "media"]) {
        const { error } = await client.from(table).delete().eq("user_id", user);
        if (error) throw new Error(error.message);
      }
    }
  });
  afterAll(() => new Promise<void>((r) => proxy.close(() => r())));

  const remoteFor = (user: string) => {
    const client = createClient(url, "anon-key-not-used", { accessToken: async () => jwt(user) });
    const remote = new SupabaseRemote(client, user);
    remote.uploadMedia = async (path, data) => void files.set(path, data);
    remote.downloadMedia = async (path) => files.get(path)!;
    return remote;
  };

  it("syncs two devices through Postgres, isolated per user", async () => {
    const run = Date.now().toString(36);
    const a = new StudyDB(`it-a-${run}`);
    const b = new StudyDB(`it-b-${run}`);
    const other = new StudyDB(`it-other-${run}`);
    const guid = `note-${run}`;
    const cardId = `${guid}:0`;

    await a.transaction("rw", [a.notes, a.cards, a.revlog, a.media, a.outbox], async () => {
      await a.notes.put({ guid, notetypeId: "builtin-basic", fields: ["\\(\\int_0^1 x\\,dx\\)", "\\(\\tfrac12\\)"], tags: ["calc"] });
      await a.cards.put({ id: cardId, noteGuid: guid, ord: 0, deck: "Math::Calculus", position: 0, suspended: false, sched: newSchedule() });
      await a.revlog.put({ id: crypto.randomUUID(), cardId, deck: "Math::Calculus", time: Date.now(), rating: 3, prevState: 0 });
      await a.media.put({ name: "plot.png", data: new Blob([new Uint8Array([9, 9])], { type: "image/png" }), size: 2 });
      await track(a, "notes", [guid]);
      await track(a, "cards", [cardId]);
      await track(a, "revlog", (await a.revlog.toCollection().primaryKeys()) as string[]);
      await track(a, "media", ["plot.png"]);
    });

    expect(await sync(a, remoteFor(USER_A))).toEqual({ pushed: 4, pulled: 0 });
    expect((await sync(b, remoteFor(USER_A))).pulled).toBe(4);
    expect(await b.notes.get(guid)).toEqual(await a.notes.get(guid));
    expect(await b.cards.get(cardId)).toEqual(await a.cards.get(cardId));
    expect((await b.media.get("plot.png"))?.remotePath).toMatch(/^[0-9a-f]{64}$/);

    // An edit on B shows up on A, with the server-side generated columns.
    await b.transaction("rw", [b.cards, b.outbox], async () => {
      await b.cards.update(cardId, { deck: "Math::Analysis" });
      await track(b, "cards", [cardId]);
    });
    await sync(b, remoteFor(USER_A));
    await sync(a, remoteFor(USER_A));
    expect((await a.cards.get(cardId))?.deck).toBe("Math::Analysis");

    // Another account sees none of it.
    await sync(other, remoteFor(USER_B));
    expect(await other.cards.count()).toBe(0);
    expect(await other.notes.count()).toBe(0);

    // And can't overwrite A's rows by reusing the same ids.
    await expect(remoteFor(USER_B).upsert("cards", [{ id: cardId, data: { hacked: true }, deleted: false }]).then(
      () => remoteFor(USER_A).changes("cards", undefined, 0, 1000),
    )).resolves.toSatisfy((rows: { id: string; data: { deck?: string } }[]) =>
      rows.find((r) => r.id === cardId)?.data.deck === "Math::Analysis",
    );
    // Spoofing user_id is rejected by row level security.
    const spoof = new SupabaseRemote(createClient(url, "x", { accessToken: async () => jwt(USER_B) }), USER_A);
    await expect(spoof.upsert("cards", [{ id: "spoof", data: {}, deleted: false }])).rejects.toThrow(/row-level security/);
  });
});
