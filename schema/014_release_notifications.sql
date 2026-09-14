-- 014_release_notifications.sql — Discord ping before a release drops.
--
-- Runs inside Postgres via pg_cron/pg_net, not on Vercel: see
-- PHASE_10_RELEASE_NOTIFICATIONS.md and docs/DECISIONS.md for why (Hobby
-- cron can't run sub-daily) and how the polling window is chosen.

create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table releases add column notified_at timestamptz;

-- format_release_message — builds the entire Discord webhook body as jsonb.
-- Kept separate from the send logic so the message can change without
-- touching notify_upcoming_releases().
create or replace function format_release_message(r releases)
returns jsonb
language sql
immutable
as $$
select jsonb_build_object(
  'embeds', jsonb_build_array(
    jsonb_strip_nulls(jsonb_build_object(
      'title', left(r.title, 256),
      'url',   r.url,
      'description', nullif(
        concat_ws(' - ', r.manufacturer, r.category, nullif(r.notes, '')), ''),
      'color', case when r.drop_type_uncertain
                    then 14119565    -- #d7728d, accent
                    else 3893175     -- #3b67b7, brand
               end,
      'fields', jsonb_build_array(
        jsonb_build_object(
          'name',  'Drops',
          'value', format('<t:%s:f>' || E'\n' || '<t:%s:R>',
                          extract(epoch from r.release_at)::bigint,
                          extract(epoch from r.release_at)::bigint),
          'inline', true),
        jsonb_build_object(
          'name',  'Type',
          'value', coalesce(r.drop_type, 'unknown')
                   || case when r.drop_type_uncertain then ' (unconfirmed)' else '' end,
          'inline', true)
      )
    ))
  )
);
$$;

comment on function format_release_message(releases) is
  'jsonb_strip_nulls is required: a null "url" in the body makes Discord reject the whole message, not just that field. Timestamps use Discord''s <t:UNIX:f>/<t:UNIX:R> tokens so the client renders local time and a live countdown — no timezone handling here.';

alter function format_release_message(releases) set search_path = pg_catalog, public;

-- notify_upcoming_releases — polls for releases entering the lead window,
-- posts each to Discord, marks them sent.
--
-- SECURITY DEFINER because pg_cron runs with no authenticated session, so
-- auth.uid() is null and RLS would filter out every row. The explicit
-- user_id lookup below stands in for RLS. search_path is pinned so a
-- definer-rights function can't be hijacked by a shadowed object.
create or replace function notify_upcoming_releases()
returns integer
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_hook    text;
  v_user_id uuid;
  v_lead    interval := interval '45 minutes';
  v_row     releases%rowtype;
  v_sent    integer := 0;
begin
  select decrypted_secret into v_hook
  from vault.decrypted_secrets where name = 'discord_webhook_url';
  if v_hook is null then return 0; end if;

  select id into v_user_id from auth.users order by created_at limit 1;
  if v_user_id is null then return 0; end if;

  for v_row in
    select * from releases
    where user_id = v_user_id
      and notified_at is null
      and status = 'upcoming'
      and release_at is not null
      and release_at > now()
      and release_at <= now() + v_lead
    order by release_at
  loop
    perform net.http_post(
      url     := v_hook,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := format_release_message(v_row)
    );
    update releases set notified_at = now() where id = v_row.id;
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

comment on function notify_upcoming_releases() is
  'Filters on user_id explicitly (single-owner app: the earliest-created auth.users row) because cron has no auth.uid() for RLS to key off. The lead window (v_lead) must stay longer than the poll interval below, or a release can fall between two runs and never notify. release_at > now() is what stops the first-ever run from firing every past release at once. pg_net is async: http_post returns a request id immediately, so a failed delivery is not visible when notified_at is written and is never retried — accepted for a personal ledger, not built out further.';

select cron.schedule(
  'notify-releases',
  '*/15 * * * *',
  $$select notify_upcoming_releases()$$
);

-- SECURITY DEFINER + no grant to anon/authenticated: without this, any
-- signed-in (or anonymous) caller could invoke the function directly via
-- PostgREST (/rest/v1/rpc/notify_upcoming_releases) and spam the Discord
-- webhook on demand. pg_cron itself runs as the scheduling role, which
-- still has execute rights.
--
-- Revoking from anon/authenticated alone is not enough: Postgres grants
-- EXECUTE to PUBLIC by default at creation time, and anon/authenticated
-- inherit through that regardless of a direct revoke. Found via
-- information_schema.routine_privileges while verifying Phase 11 — the
-- earlier revoke left PUBLIC still holding it.
revoke execute on function notify_upcoming_releases() from anon, authenticated;
revoke execute on function notify_upcoming_releases() from public;
