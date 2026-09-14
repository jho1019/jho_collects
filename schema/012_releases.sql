-- 012_releases.sql — upcoming product releases, for the Phase 9 calendar.
--
-- A separate table, not a transaction type: a release is not money moving,
-- it's a thing that hasn't happened yet and might never turn into a
-- purchase. See docs/PHASES.md (Phase 9) and the release-entry skill.

create table releases (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null default auth.uid() references auth.users (id),

  release_on          date not null,          -- calendar day, America/Los_Angeles
  release_at          timestamptz,            -- null when time unknown
  time_unconfirmed    boolean not null default false,

  title               text not null,
  manufacturer        text,
  category            text,                   -- baseball, basketball, soccer, non-sport
  drop_type           text,                   -- FCFS, EQL, raffle, queue
  drop_type_uncertain boolean not null default false,

  url                 text,
  notes               text,
  status              text not null default 'upcoming',  -- upcoming | bought | skipped | missed
  needs_review        boolean not null default false,
  created_at          timestamptz not null default now()
);

comment on table releases is
  'Upcoming product releases for the calendar. Not a transaction — a release that turns into a purchase is a separate, unlinked transactions row (see Phase 9''s "not in this phase").';
comment on column releases.drop_type is
  'Free text, not an enum. Postgres has no ALTER TYPE ... DROP VALUE, and drop mechanics change often enough that a one-way door is the wrong shape (same reasoning as deals in Phase 6). The release-entry skill validates against a documented set; the column does not.';
comment on column releases.drop_type_uncertain is
  'The source text carried a "?" on the mechanic, e.g. "(EQL?)". Flattening that to a bare EQL discards the only signal that would make you check before the drop.';
comment on column releases.time_unconfirmed is
  'The source gave a date but no time. release_at is null and this is set rather than guessing a time.';

-- No CHECK on status: a small, evolving set of free-text values written by one
-- skill, same call as drop_type.

alter table releases enable row level security;
create policy own_releases on releases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index releases_user_day on releases (user_id, release_on);
