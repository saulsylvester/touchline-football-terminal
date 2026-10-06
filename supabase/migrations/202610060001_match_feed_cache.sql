-- Backend-only persisted observations and a lease shared across edge isolates.
create table if not exists public.match_feed_cache (
  fixture_id text primary key,
  feed jsonb,
  lease_owner uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.match_feed_cache enable row level security;
revoke all on public.match_feed_cache from anon, authenticated;
grant all on public.match_feed_cache to service_role;

create or replace function public.claim_match_feed(p_fixture_id text, p_owner uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare did_claim boolean;
begin
  insert into public.match_feed_cache(fixture_id) values(p_fixture_id) on conflict do nothing;
  update public.match_feed_cache
  set lease_owner = p_owner, lease_until = now() + interval '120 seconds'
  where fixture_id = p_fixture_id
    and (lease_until is null or lease_until < now())
    and (feed is null or feed->>'nextRefreshAt' is null or (feed->>'nextRefreshAt')::timestamptz <= now());
  did_claim := found;
  return did_claim;
end;
$$;

create or replace function public.save_match_feed(p_fixture_id text, p_owner uuid, p_feed jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.match_feed_cache set feed = p_feed, updated_at = now()
  where fixture_id = p_fixture_id and lease_owner = p_owner and lease_until > now();
  return found;
end;
$$;

create or replace function public.release_match_feed(p_fixture_id text, p_owner uuid)
returns void language sql security definer set search_path = public as $$
  update public.match_feed_cache set lease_owner = null, lease_until = null
  where fixture_id = p_fixture_id and lease_owner = p_owner;
$$;

revoke all on function public.claim_match_feed(text, uuid) from public, anon, authenticated;
revoke all on function public.save_match_feed(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.release_match_feed(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_match_feed(text, uuid) to service_role;
grant execute on function public.save_match_feed(text, uuid, jsonb) to service_role;
grant execute on function public.release_match_feed(text, uuid) to service_role;
