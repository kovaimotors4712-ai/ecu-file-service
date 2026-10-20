-- Additive community forum schema. Do not apply until production project and migration history are confirmed.
-- Does not alter orders, checkout intents, payment providers, or private-ecu-files.
begin;

create table if not exists public.forum_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,24}$'),
  display_name text not null check (char_length(trim(display_name)) between 1 and 60),
  bio text check (bio is null or char_length(bio) <= 280),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists forum_profiles_username_lower_uidx on public.forum_profiles (lower(username));

create table if not exists public.forum_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (char_length(trim(title)) between 2 and 80),
  description text not null default '' check (char_length(description) <= 240),
  sort_order integer not null default 100,
  is_active boolean not null default true,
  is_locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.forum_topics (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null constraint forum_topics_category_id_fkey references public.forum_categories(id) on delete restrict,
  author_id uuid not null constraint forum_topics_author_id_fkey references public.forum_profiles(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 12 and 140),
  body text not null check (char_length(trim(body)) between 20 and 12000),
  status text not null default 'published' check (status in ('published','locked','hidden','deleted')),
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists forum_topics_public_updated_idx on public.forum_topics (is_pinned desc, updated_at desc) where status in ('published','locked');
create index if not exists forum_topics_category_updated_idx on public.forum_topics (category_id, updated_at desc) where status in ('published','locked');
create index if not exists forum_topics_author_created_idx on public.forum_topics (author_id, created_at desc);

create table if not exists public.forum_posts (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null constraint forum_posts_topic_id_fkey references public.forum_topics(id) on delete cascade,
  author_id uuid not null constraint forum_posts_author_id_fkey references public.forum_profiles(id) on delete restrict,
  body text not null check (char_length(trim(body)) between 2 and 10000),
  status text not null default 'published' check (status in ('published','hidden','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists forum_posts_topic_created_idx on public.forum_posts (topic_id, created_at) where status='published';
create index if not exists forum_posts_author_created_idx on public.forum_posts (author_id, created_at desc);

create table if not exists public.forum_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.forum_profiles(id) on delete restrict,
  target_type text not null check (target_type in ('topic','post')),
  target_id uuid not null,
  reason text not null check (reason in ('spam','abuse','privacy','copyright','unsafe','other')),
  details text not null check (char_length(trim(details)) between 10 and 1000),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists forum_reports_one_open_per_user_target_uidx on public.forum_reports (reporter_id, target_type, target_id) where status='open';
create index if not exists forum_reports_open_created_idx on public.forum_reports (created_at) where status='open';

create table if not exists public.forum_moderation_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  table_name text not null check (table_name in ('forum_topics','forum_posts','forum_reports')),
  record_id uuid not null,
  action text not null,
  old_status text,
  new_status text,
  created_at timestamptz not null default now()
);
create index if not exists forum_moderation_events_created_idx on public.forum_moderation_events (created_at desc);

create or replace function public.forum_is_admin()
returns boolean language sql stable security invoker set search_path = ''
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'role' = 'admin', false) $$;
grant execute on function public.forum_is_admin() to anon, authenticated, service_role;

create or replace function public.forum_guard_profile()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.id is distinct from old.id then raise exception 'Profile identity cannot be changed.' using errcode='42501'; end if;
  if not public.forum_is_admin() and new.id is distinct from auth.uid() then raise exception 'You may only manage your own forum profile.' using errcode='42501'; end if;
  new.username := trim(new.username); new.display_name := trim(new.display_name); new.bio := nullif(trim(coalesce(new.bio,'')), '');
  new.updated_at := now();
  if new.username !~ '^[A-Za-z0-9_]{3,24}$' or char_length(new.display_name) not between 1 and 60 or char_length(coalesce(new.bio,'')) > 280 then
    raise exception 'Profile fields exceed allowed limits.' using errcode='22023';
  end if;
  if tg_op='UPDATE' and not public.forum_is_admin() and new.created_at is distinct from old.created_at then raise exception 'Profile creation time cannot be changed.' using errcode='42501'; end if;
  return new;
end;
$$;

create or replace function public.forum_guard_topic()
returns trigger language plpgsql set search_path = '' as $$
declare cat public.forum_categories%rowtype;
begin
  if current_setting('efsi.forum_internal_topic_bump', true) = 'on' then new.updated_at := now(); return new; end if;
  if not public.forum_is_admin() then
    if new.author_id is distinct from auth.uid() then raise exception 'Topic author must match signed-in account.' using errcode='42501'; end if;
    if tg_op='INSERT' then
      select * into cat from public.forum_categories where id=new.category_id and is_active=true;
      if not found or cat.is_locked then raise exception 'This category is not accepting topics.' using errcode='42501'; end if;
      new.status := 'published'; new.is_pinned := false; new.created_at := now();
    else
      if new.author_id is distinct from old.author_id or new.category_id is distinct from old.category_id or new.status is distinct from old.status or new.is_pinned is distinct from old.is_pinned or new.created_at is distinct from old.created_at then
        raise exception 'Members cannot change ownership, category, moderation status, pin, or creation time.' using errcode='42501';
      end if;
    end if;
  end if;
  new.title := trim(new.title); new.body := trim(new.body); new.updated_at := now();
  if char_length(new.title) not between 12 and 140 or char_length(new.body) not between 20 and 12000 then raise exception 'Topic title or body length is invalid.' using errcode='22023'; end if;
  return new;
end;
$$;

create or replace function public.forum_guard_post()
returns trigger language plpgsql set search_path = '' as $$
declare topic_status text;
begin
  if not public.forum_is_admin() then
    if new.author_id is distinct from auth.uid() then raise exception 'Reply author must match signed-in account.' using errcode='42501'; end if;
    if tg_op='INSERT' then
      select status into topic_status from public.forum_topics where id=new.topic_id;
      if topic_status is distinct from 'published' then raise exception 'This topic is locked or unavailable for replies.' using errcode='42501'; end if;
      new.status := 'published'; new.created_at := now();
    else
      if new.author_id is distinct from old.author_id or new.topic_id is distinct from old.topic_id or new.status is distinct from old.status or new.created_at is distinct from old.created_at then
        raise exception 'Members cannot change reply ownership, topic, moderation status, or creation time.' using errcode='42501';
      end if;
    end if;
  end if;
  new.body := trim(new.body); new.updated_at := now();
  if char_length(new.body) not between 2 and 10000 then raise exception 'Reply length is invalid.' using errcode='22023'; end if;
  return new;
end;
$$;

create or replace function public.forum_guard_report()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' then
    if new.reporter_id is distinct from auth.uid() and not public.forum_is_admin() then raise exception 'Reporter must match signed-in account.' using errcode='42501'; end if;
    new.status := 'open'; new.reviewed_by := null; new.reviewed_at := null; new.created_at := now();
    if new.target_type='topic' then
      if not exists (select 1 from public.forum_topics where id=new.target_id and status in ('published','locked')) then raise exception 'Report target is unavailable.' using errcode='22023'; end if;
    elsif new.target_type='post' then
      if not exists (select 1 from public.forum_posts where id=new.target_id and status='published') then raise exception 'Report target is unavailable.' using errcode='22023'; end if;
    end if;
  else
    if not public.forum_is_admin() then raise exception 'Only moderators may review reports.' using errcode='42501'; end if;
    if new.reporter_id is distinct from old.reporter_id or new.target_type is distinct from old.target_type or new.target_id is distinct from old.target_id or new.reason is distinct from old.reason or new.details is distinct from old.details or new.created_at is distinct from old.created_at then
      raise exception 'Report details are immutable during review.' using errcode='42501';
    end if;
    new.reviewed_by := auth.uid(); new.reviewed_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.forum_enforce_post_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare recent_count integer;
begin
  if public.forum_is_admin() then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.author_id::text, 0));
  if tg_table_name='forum_topics' then
    select count(*) into recent_count from public.forum_topics where author_id=new.author_id and created_at > now() - interval '5 minutes';
    if recent_count >= 3 then raise exception 'For community safety, wait before creating another topic.' using errcode='P0001'; end if;
  else
    select count(*) into recent_count from public.forum_posts where author_id=new.author_id and created_at > now() - interval '30 seconds';
    if recent_count >= 1 then raise exception 'Please wait before posting another reply.' using errcode='P0001'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.forum_enforce_report_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare recent_count integer;
begin
  if public.forum_is_admin() then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.reporter_id::text, 0));
  select count(*) into recent_count from public.forum_reports where reporter_id=new.reporter_id and created_at > now() - interval '30 minutes';
  if recent_count >= 3 then raise exception 'For community safety, wait before submitting another report.' using errcode='P0001'; end if;
  return new;
end;
$$;

create or replace function public.forum_bump_topic_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('efsi.forum_internal_topic_bump','on',true);
  update public.forum_topics set updated_at=now() where id=new.topic_id;
  perform set_config('efsi.forum_internal_topic_bump','off',true);
  return new;
end;
$$;

create or replace function public.forum_log_moderation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare old_status text; new_status text; record_id uuid;
begin
  old_status := to_jsonb(old)->>'status'; new_status := to_jsonb(new)->>'status'; record_id := (to_jsonb(new)->>'id')::uuid;
  if old_status is distinct from new_status and public.forum_is_admin() then
    insert into public.forum_moderation_events(actor_id,table_name,record_id,action,old_status,new_status)
    values(auth.uid(),tg_table_name,record_id,'status_changed',old_status,new_status);
  end if;
  return new;
end;
$$;

grant select on public.forum_profiles, public.forum_categories, public.forum_topics, public.forum_posts to anon, authenticated;
grant insert, update on public.forum_profiles, public.forum_topics, public.forum_posts, public.forum_reports to authenticated;
grant select, update on public.forum_categories to authenticated;
grant select on public.forum_reports, public.forum_moderation_events to authenticated;

alter table public.forum_profiles enable row level security;
alter table public.forum_categories enable row level security;
alter table public.forum_topics enable row level security;
alter table public.forum_posts enable row level security;
alter table public.forum_reports enable row level security;
alter table public.forum_moderation_events enable row level security;

drop policy if exists forum_profiles_public_read on public.forum_profiles;
create policy forum_profiles_public_read on public.forum_profiles for select to anon, authenticated using (true);
drop policy if exists forum_profiles_self_insert on public.forum_profiles;
create policy forum_profiles_self_insert on public.forum_profiles for insert to authenticated with check (id=auth.uid());
drop policy if exists forum_profiles_self_update on public.forum_profiles;
create policy forum_profiles_self_update on public.forum_profiles for update to authenticated using (id=auth.uid() or public.forum_is_admin()) with check (id=auth.uid() or public.forum_is_admin());

drop policy if exists forum_categories_active_read on public.forum_categories;
create policy forum_categories_active_read on public.forum_categories for select to anon, authenticated using (is_active=true or public.forum_is_admin());
drop policy if exists forum_categories_admin_write on public.forum_categories;
create policy forum_categories_admin_write on public.forum_categories for update to authenticated using (public.forum_is_admin()) with check (public.forum_is_admin());

drop policy if exists forum_topics_public_read on public.forum_topics;
create policy forum_topics_public_read on public.forum_topics for select to anon, authenticated using (status in ('published','locked') or public.forum_is_admin());
drop policy if exists forum_topics_member_insert on public.forum_topics;
create policy forum_topics_member_insert on public.forum_topics for insert to authenticated with check (author_id=auth.uid() and status='published' and is_pinned=false and exists (select 1 from public.forum_categories c where c.id=category_id and c.is_active=true and c.is_locked=false));
drop policy if exists forum_topics_author_update on public.forum_topics;
create policy forum_topics_author_update on public.forum_topics for update to authenticated using (author_id=auth.uid() and status='published' and is_pinned=false) with check (author_id=auth.uid() and status='published' and is_pinned=false);
drop policy if exists forum_topics_admin_all on public.forum_topics;
create policy forum_topics_admin_all on public.forum_topics for all to authenticated using (public.forum_is_admin()) with check (public.forum_is_admin());

drop policy if exists forum_posts_public_read on public.forum_posts;
create policy forum_posts_public_read on public.forum_posts for select to anon, authenticated using ((status='published' and exists (select 1 from public.forum_topics t where t.id=topic_id and t.status in ('published','locked'))) or public.forum_is_admin());
drop policy if exists forum_posts_member_insert on public.forum_posts;
create policy forum_posts_member_insert on public.forum_posts for insert to authenticated with check (author_id=auth.uid() and status='published' and exists (select 1 from public.forum_topics t where t.id=topic_id and t.status='published'));
drop policy if exists forum_posts_author_update on public.forum_posts;
create policy forum_posts_author_update on public.forum_posts for update to authenticated using (author_id=auth.uid() and status='published') with check (author_id=auth.uid() and status='published');
drop policy if exists forum_posts_admin_all on public.forum_posts;
create policy forum_posts_admin_all on public.forum_posts for all to authenticated using (public.forum_is_admin()) with check (public.forum_is_admin());

drop policy if exists forum_reports_member_insert on public.forum_reports;
create policy forum_reports_member_insert on public.forum_reports for insert to authenticated with check (reporter_id=auth.uid() and status='open');
drop policy if exists forum_reports_admin_read on public.forum_reports;
create policy forum_reports_admin_read on public.forum_reports for select to authenticated using (public.forum_is_admin());
drop policy if exists forum_reports_admin_update on public.forum_reports;
create policy forum_reports_admin_update on public.forum_reports for update to authenticated using (public.forum_is_admin()) with check (public.forum_is_admin());
drop policy if exists forum_moderation_events_admin_read on public.forum_moderation_events;
create policy forum_moderation_events_admin_read on public.forum_moderation_events for select to authenticated using (public.forum_is_admin());

drop trigger if exists forum_profiles_guard on public.forum_profiles;
create trigger forum_profiles_guard before insert or update on public.forum_profiles for each row execute function public.forum_guard_profile();
drop trigger if exists forum_categories_touch_updated_at on public.forum_categories;
create trigger forum_categories_touch_updated_at before update on public.forum_categories for each row execute function public.forum_touch_updated_at();
drop trigger if exists forum_topics_guard on public.forum_topics;
create trigger forum_topics_guard before insert or update on public.forum_topics for each row execute function public.forum_guard_topic();
drop trigger if exists forum_topics_rate_limit on public.forum_topics;
create trigger forum_topics_rate_limit before insert on public.forum_topics for each row execute function public.forum_enforce_post_rate_limit();
drop trigger if exists forum_topics_moderation_log on public.forum_topics;
create trigger forum_topics_moderation_log after update of status on public.forum_topics for each row execute function public.forum_log_moderation();
drop trigger if exists forum_posts_guard on public.forum_posts;
create trigger forum_posts_guard before insert or update on public.forum_posts for each row execute function public.forum_guard_post();
drop trigger if exists forum_posts_rate_limit on public.forum_posts;
create trigger forum_posts_rate_limit before insert on public.forum_posts for each row execute function public.forum_enforce_post_rate_limit();
drop trigger if exists forum_posts_bump_topic_activity on public.forum_posts;
create trigger forum_posts_bump_topic_activity after insert on public.forum_posts for each row execute function public.forum_bump_topic_activity();
drop trigger if exists forum_posts_moderation_log on public.forum_posts;
create trigger forum_posts_moderation_log after update of status on public.forum_posts for each row execute function public.forum_log_moderation();
drop trigger if exists forum_reports_guard on public.forum_reports;
create trigger forum_reports_guard before insert or update on public.forum_reports for each row execute function public.forum_guard_report();
drop trigger if exists forum_reports_rate_limit on public.forum_reports;
create trigger forum_reports_rate_limit before insert on public.forum_reports for each row execute function public.forum_enforce_report_rate_limit();
drop trigger if exists forum_reports_moderation_log on public.forum_reports;
create trigger forum_reports_moderation_log after update of status on public.forum_reports for each row execute function public.forum_log_moderation();

revoke all on function public.forum_guard_profile() from public, anon, authenticated;
revoke all on function public.forum_guard_topic() from public, anon, authenticated;
revoke all on function public.forum_guard_post() from public, anon, authenticated;
revoke all on function public.forum_guard_report() from public, anon, authenticated;
revoke all on function public.forum_enforce_post_rate_limit() from public, anon, authenticated;
revoke all on function public.forum_enforce_report_rate_limit() from public, anon, authenticated;
revoke all on function public.forum_bump_topic_activity() from public, anon, authenticated;
revoke all on function public.forum_log_moderation() from public, anon, authenticated;
revoke all on function public.forum_touch_updated_at() from public, anon, authenticated;

insert into public.forum_categories(slug,title,description,sort_order) values
  ('ecu-diagnostics','ECU Diagnostics','ECU identification, scan tools, live data and diagnostic workflows.',10),
  ('fault-codes','Fault Codes & Troubleshooting','DTCs, symptoms, test values and repair confirmation.',20),
  ('ecu-remapping','ECU Remapping & Calibration','Calibration theory, tooling, validation and legal considerations.',30),
  ('automotive-electronics','Automotive Electronics','ECUs, BCMs, ABS, SRS and electronic modules.',40),
  ('wiring-diagrams','Wiring & Pinouts','Connector identification, wiring checks and diagrams.',50),
  ('tools-and-software','Tools & Software','Legitimate diagnostic tools, licensed software and setup.',60),
  ('vehicle-specific','Vehicle-Specific Help','Make/model discussions and workshop cases.',70),
  ('general-workshop','General Workshop','Repair practice, safety and community questions.',80)
on conflict (slug) do nothing;

commit;
