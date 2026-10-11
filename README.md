# Study Hard

A private, local-first flashcard app. It reads Anki packages and open deck
formats, renders math with MathJax, and schedules reviews with FSRS (the
algorithm modern Anki uses).

Everything runs in your browser. Decks, media and review history are stored
in IndexedDB on your device, and MathJax is bundled locally, so the app makes
no CDN requests. Optionally, connect your own Supabase project to sync your
collection between your phone and computer.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — host anywhere or open via `npm run preview`
npm test           # unit + package-format tests
```

## Supported formats

| Format | Import | Export |
| --- | --- | --- |
| Anki `.apkg` / `.colpkg`, legacy (`collection.anki2`/`.anki21`) and current (zstd `collection.anki21b`, Anki 2.1.50+) | ✅ notes, note types, card templates and CSS, subdecks, media, tags, suspended state, review intervals | — |
| [CrowdAnki](https://github.com/Stvad/CrowdAnki) JSON (`deck.json`, a zipped deck folder, or the folder itself via **Import folder**) | ✅ | ✅ (zip per deck) |
| CSV / TSV (`Front, Back`, or cloze text in column 1), including Anki's `#separator:`, `#html:`, `#deck:`, `#notetype:`, `#tags:` and `#… column:` headers | ✅ | — |

Re-importing a package updates notes in place (they are matched by Anki's
note GUID), and your review progress here is kept.

## Math

Cards render the same way Anki renders them:

- `\( … \)` for inline math and `\[ … \]` for display math, plus `\begin{align}`-style environments
- Anki's image-LaTeX tags `[$]…[/$]`, `[$$]…[/$$]` and `[latex]…[/latex]`, which are converted to MathJax
- `\ce{…}` chemistry via mhchem
- clozes inside equations, e.g. `\(x = {{c1::2}}\)`, which show as a boxed `?` until revealed

## Card templates

The template engine implements Anki's syntax: `{{Field}}`, `{{#Field}}…{{/Field}}`,
`{{^Field}}…{{/Field}}`, `{{FrontSide}}`, chained filters (`text:`, `cloze:`,
`cloze-only:`, `hint:`, `type:`, `furigana:`, `kana:`, `kanji:`), the special
fields `Tags`, `Type`, `Deck`, `Subdeck` and `Card`, and nested or
multi-number clozes (`{{c1,2::…}}`). `[sound:…]` becomes an audio player.

Cards render inside a sandboxed iframe. Templates that include JavaScript still
run, but they cannot reach the app or its stored data.

## Studying

Keys: <kbd>Space</kbd>/<kbd>Enter</kbd> show the answer, then rate the card Good.
<kbd>1</kbd>–<kbd>4</kbd> rate Again / Hard / Good / Easy, <kbd>Z</kbd> undoes,
<kbd>@</kbd> suspends, and <kbd>Esc</kbd> goes back to the deck list.
**Settings** holds the daily limits, desired retention, the hour the day rolls
over, and the theme.

Cards that were in review in Anki keep their due date and interval. Anki's
FSRS memory state is used when the package has it; otherwise it is estimated
from the interval and ease.

## Sync between devices (Supabase)

The app stays local-first. Each device keeps a full copy and works offline.
Changes go into an outbox and are pushed to your Supabase Postgres, and other
devices pull whatever changed since their last sync. Sync runs on startup, a
few seconds after you study or import, when the app regains focus, when the
device comes back online, and every two minutes while the app is open.

**One-time setup**

1. Create a project at [supabase.com](https://supabase.com).
2. In the **SQL Editor**, run
   [`supabase/migrations/20261011000000_study_hard_sync.sql`](supabase/migrations/20261011000000_study_hard_sync.sql)
   (or `supabase db push` with the Supabase CLI). It creates the tables, row level
   security policies, and a private `media` storage bucket.
3. Host the app somewhere with HTTPS so your phone can open it: `npm run build`
   and deploy `dist/` to Netlify, Vercel, Cloudflare Pages or GitHub Pages. Add
   that URL under **Authentication → URL Configuration** in Supabase.
4. Open the app, click **Sync off** in the header, and enter the project URL
   and the publishable (anon) key from **Project Settings → API**. To skip this
   step on each device, put them in `.env.local` before building (see
   `.env.example`).
5. Click **Create account**, confirm your email, then sign in on each device.
6. To keep the project private, turn off **Allow new users to sign up** under
   **Authentication → Sign In / Providers** once your account exists.

**What syncs:** note types, notes, cards with their scheduling, the review log,
and media. Media files go to the storage bucket, and other devices download
each file the first time a card needs it.

**Conflicts:** if two devices change the same card before syncing, the one
that syncs last wins. Review history merges from both devices, since every
review has its own ID.

**Your data in Postgres:** each table stores the app's record as `data jsonb`,
with convenience columns for SQL. For example, to list the cards due today:
`select deck, count(*) from cards where not deleted and due < now() group by deck;`

## Development

- `src/importers/`: package readers (`apkg.ts`, `crowdanki.ts`, `csv.ts`, and `protobuf.ts` for Anki's protobuf blobs)
- `src/render/`: template engine, cloze, media inlining, and the MathJax card frame
- `src/store.ts`, `src/db.ts`, `src/scheduler.ts`: IndexedDB storage, study queue, FSRS
- `src/sync/`: change tracking, the sync engine and the Supabase client
- `src/ui/`, `src/main.ts`: the interface
- `supabase/migrations/`: the Postgres schema

The `.apkg`/`.colpkg` test fixtures are generated with the real Anki library:

```sh
python -m venv .venv && .venv/bin/pip install anki
.venv/bin/python scripts/make_fixtures.py tests/fixtures
```

To test sync against a real Postgres, apply `tests/sql/supabase_stub.sql`, the
migration and `tests/sql/rls_test.sql` to a scratch database, then run
PostgREST on it and `npm run test:integration` (see the header of
`tests/supabase.integration.test.ts`).

## Not yet supported

A note editor, Image Occlusion note types, filtered decks, and
text-to-speech (`{{tts:…}}` renders as nothing).
