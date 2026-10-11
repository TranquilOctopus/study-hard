import type { SupabaseClient } from "@supabase/supabase-js";
import type { Remote, RemoteRow, RowWrite } from "./engine";

export const MEDIA_BUCKET = "media";

/** Sync server backed by Supabase (Postgres tables + a Storage bucket). */
export class SupabaseRemote implements Remote {
  constructor(
    private readonly client: SupabaseClient,
    readonly userId: string,
  ) {}

  async upsert(table: string, rows: RowWrite[]): Promise<void> {
    const { error } = await this.client
      .from(table)
      .upsert(rows.map((r) => ({ user_id: this.userId, ...r })), { onConflict: "user_id,id" });
    if (error) throw new Error(`Upload to ${table} failed: ${error.message}`);
  }

  async changes(table: string, since: string | undefined, offset: number, limit: number): Promise<RemoteRow[]> {
    let query = this.client
      .from(table)
      .select("id, data, deleted, updated_at")
      .eq("user_id", this.userId)
      .order("updated_at")
      .order("id")
      .range(offset, offset + limit - 1);
    if (since) query = query.gt("updated_at", since);
    const { data, error } = await query;
    if (error) throw new Error(`Download from ${table} failed: ${error.message}`);
    return data as RemoteRow[];
  }

  async uploadMedia(path: string, data: Blob): Promise<void> {
    const { error } = await this.client.storage
      .from(MEDIA_BUCKET)
      .upload(path, data, { upsert: true, contentType: data.type || "application/octet-stream" });
    if (error) throw new Error(`Media upload failed: ${error.message}`);
  }

  async downloadMedia(path: string): Promise<Blob> {
    const { data, error } = await this.client.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) throw new Error(`Media download failed: ${error?.message ?? "no data"}`);
    return data;
  }
}
