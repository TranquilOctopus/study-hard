-- Study Hard sync schema.
--
-- Every synced table has the same shape: one row per record, owned by a
-- user, holding the app's record as JSON. Deletions are kept as tombstones
-- (deleted = true) so other devices learn about them. updated_at is set by
-- the server and is what devices pull changes by.

create or replace function public.study_hard_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create table public.notetypes (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  name text generated always as (data ->> 'name') stored,
  primary key (user_id, id)
);

create table public.notes (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  notetype_id text generated always as (data ->> 'notetypeId') stored,
  primary key (user_id, id)
);

create table public.cards (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  -- Convenience columns for querying the collection with SQL.
  note_id text generated always as (data ->> 'noteGuid') stored,
  deck text generated always as (data ->> 'deck') stored,
  due timestamptz generated always as (to_timestamp((data -> 'sched' ->> 'due')::double precision / 1000)) stored,
  primary key (user_id, id)
);

create table public.review_log (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  card_id text generated always as (data ->> 'cardId') stored,
  reviewed_at timestamptz generated always as (to_timestamp((data ->> 'time')::double precision / 1000)) stored,
  rating smallint generated always as ((data ->> 'rating')::smallint) stored,
  primary key (user_id, id)
);

-- Media metadata; the files themselves live in the private "media" bucket
-- under <user id>/<path>.
create table public.media (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

do $$
declare
  t text;
begin
  foreach t in array array['notetypes', 'notes', 'cards', 'review_log', 'media'] loop
    execute format('create index %I on public.%I (user_id, updated_at)', t || '_changes_idx', t);
    execute format(
      'create trigger study_hard_touch before insert or update on public.%I
         for each row execute function public.study_hard_touch()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "Owners manage their rows" on public.%I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

create index cards_deck_due_idx on public.cards (user_id, deck, due) where not deleted;

-- Private bucket for images, audio and fonts referenced by cards.
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

create policy "Owners read their media" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owners upload their media" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owners replace their media" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owners delete their media" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
