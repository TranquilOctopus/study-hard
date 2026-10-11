-- Run after supabase_stub.sql and the migration:
--   psql -v ON_ERROR_STOP=1 -f tests/sql/rls_test.sql
-- Raises an exception if any expectation fails.
insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');

do $$
declare
  n int;
  before_ts timestamptz;
  after_ts timestamptz;
begin
  -- User A writes a card.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a"}', true);
  insert into public.cards (id, data)
  values ('g1:0', '{"noteGuid":"g1","deck":"Math::Algebra","sched":{"due":1791714713000}}');
  select updated_at into before_ts from public.cards where id = 'g1:0';

  select count(*) into n from public.cards where deck = 'Math::Algebra' and note_id = 'g1'
    and due = to_timestamp(1791714713);
  if n <> 1 then raise exception 'generated columns wrong (%)', n; end if;

  -- Upserting the same key updates the row and bumps updated_at.
  insert into public.cards (user_id, id, data) values (auth.uid(), 'g1:0', '{"deck":"Other"}')
  on conflict (user_id, id) do update set data = excluded.data;
  select updated_at into after_ts from public.cards where id = 'g1:0';
  if after_ts <= before_ts then raise exception 'updated_at not bumped'; end if;

  -- User B sees nothing of A's and cannot write rows as A.
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b"}', true);
  select count(*) into n from public.cards;
  if n <> 0 then raise exception 'user B can see % of A''s cards', n; end if;
  update public.cards set deleted = true;
  begin
    insert into public.cards (user_id, id, data) values ('00000000-0000-0000-0000-00000000000a', 'x', '{}');
    raise exception 'user B inserted a row owned by A';
  exception when insufficient_privilege then null;
  end;

  -- Storage: B can't read or write under A's folder; can under its own.
  insert into storage.objects (bucket_id, name) values ('media', '00000000-0000-0000-0000-00000000000b/abc');
  begin
    insert into storage.objects (bucket_id, name) values ('media', '00000000-0000-0000-0000-00000000000a/abc');
    raise exception 'user B uploaded into A''s folder';
  exception when insufficient_privilege then null;
  end;

  -- Anonymous requests can't read anything.
  perform set_config('role', 'anon', true);
  begin
    select count(*) into n from public.cards;
    raise exception 'anon could read cards';
  exception when insufficient_privilege then null;
  end;

  -- Back as A: the row is untouched by B's update attempt.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a"}', true);
  select count(*) into n from public.cards where not deleted;
  if n <> 1 then raise exception 'A''s card was modified by B'; end if;
  select count(*) into n from storage.objects;
  if n <> 0 then raise exception 'A can see B''s media'; end if;
  perform set_config('role', 'postgres', true);
  raise notice 'RLS tests passed';
end;
$$;
