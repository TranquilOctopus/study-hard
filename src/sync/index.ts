// Sync controller: owns the Supabase client and session, and runs sync when
// the app starts, after local changes, when the tab regains focus and when
// the device comes back online.

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { db } from "../db";
import { setMediaFetcher } from "../mediaStore";
import { AccountMismatchError, fetchMedia, resetLocal, sync } from "./engine";
import { SupabaseRemote } from "./remote";
import { onLocalChange } from "./tracking";

export interface SyncConfig {
  url: string;
  anonKey: string;
}

export type SyncState = "off" | "signed-out" | "idle" | "syncing" | "offline" | "error" | "mismatch";

export interface SyncStatus {
  state: SyncState;
  email?: string;
  lastSync?: number;
  message?: string;
}

const CONFIG_KEY = "study-hard:supabase";
const LOCAL_CHANGE_DELAY_MS = 4000;
const POLL_MS = 2 * 60_000;

let client: SupabaseClient | undefined;
let session: Session | null = null;
let status: SyncStatus = { state: "off" };
let timer: number | undefined;
let running = false;
let rerun = false;

/** Fires "status" when SyncStatus changes and "pulled" after remote changes arrive. */
export const syncEvents = new EventTarget();

export const getStatus = () => status;

function setStatus(next: SyncStatus): void {
  status = next;
  syncEvents.dispatchEvent(new Event("status"));
}

export function getConfig(): SyncConfig | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null") as SyncConfig | null;
    if (saved?.url && saved.anonKey) return saved;
  } catch {
    // Fall through to build-time configuration.
  }
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return url && anonKey ? { url, anonKey } : undefined;
}

const remote = () => (client && session ? new SupabaseRemote(client, session.user.id) : undefined);

function signedInStatus(): SyncStatus {
  return { state: "idle", email: session?.user.email, lastSync: status.lastSync };
}

async function connect(): Promise<void> {
  const cfg = getConfig();
  session = null;
  if (!cfg) {
    client = undefined;
    return setStatus({ state: "off" });
  }
  // Loaded on demand so people who don't sync never download the client.
  const { createClient } = await import("@supabase/supabase-js");
  client = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "study-hard-auth" },
  });
  const current = client;
  current.auth.onAuthStateChange((event, s) => {
    if (client !== current) return;
    session = s;
    if (event === "SIGNED_OUT" || !s) setStatus({ state: "signed-out" });
    else if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
      if (status.state !== "syncing") setStatus(signedInStatus());
      requestSync(0);
    }
  });
  const { data } = await current.auth.getSession();
  session = data.session;
  setStatus(session ? signedInStatus() : { state: "signed-out" });
}

async function runSync(): Promise<void> {
  const r = remote();
  if (!r) return;
  if (running) {
    rerun = true;
    return;
  }
  if (!navigator.onLine) return setStatus({ ...signedInStatus(), state: "offline" });
  running = true;
  setStatus({ ...signedInStatus(), state: "syncing" });
  try {
    const result = await sync(db, r);
    setStatus({ ...signedInStatus(), lastSync: Date.now() });
    if (result.pulled) syncEvents.dispatchEvent(new Event("pulled"));
  } catch (err) {
    console.error(err);
    const state = err instanceof AccountMismatchError ? "mismatch" : "error";
    setStatus({ ...signedInStatus(), state, message: (err as Error).message });
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      requestSync(0);
    }
  }
}

export function requestSync(delayMs = 0): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => void runSync(), delayMs);
}

export async function initSync(): Promise<void> {
  onLocalChange(() => requestSync(LOCAL_CHANGE_DELAY_MS));
  setMediaFetcher(async (rec) => {
    const r = remote();
    return r ? fetchMedia(db, r, rec) : undefined;
  });
  window.addEventListener("online", () => requestSync(0));
  window.addEventListener("offline", () => session && setStatus({ ...signedInStatus(), state: "offline" }));
  // Push right away when the app is backgrounded (e.g. switching apps on a
  // phone) and pull when it comes back.
  document.addEventListener("visibilitychange", () => requestSync(0));
  window.setInterval(() => document.visibilityState === "visible" && requestSync(0), POLL_MS);
  await connect();
}

// -------------------------------------------------------------- actions --

export async function configure(cfg: SyncConfig | undefined): Promise<void> {
  try {
    if (cfg) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    throw new Error("This browser blocks local storage, so the sync settings can't be saved.");
  }
  await client?.auth.signOut({ scope: "local" }).catch(() => undefined);
  await connect();
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!client) throw new Error("Sync isn't configured");
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** Returns true when the account still needs its email confirmed. */
export async function signUp(email: string, password: string): Promise<boolean> {
  if (!client) throw new Error("Sync isn't configured");
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: location.href.split("#")[0] },
  });
  if (error) throw error;
  return !data.session;
}

export async function signOut(): Promise<void> {
  await client?.auth.signOut({ scope: "local" });
}

/** Erases this device's data and downloads the signed-in account's instead. */
export async function replaceLocalWithAccount(): Promise<void> {
  await resetLocal(db);
  await runSync();
  syncEvents.dispatchEvent(new Event("pulled"));
}
