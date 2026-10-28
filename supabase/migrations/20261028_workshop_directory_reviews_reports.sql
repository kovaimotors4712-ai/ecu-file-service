-- Workshop directory, customer reviews, complaint reports and admin audit trail.
-- All write access is constrained by authenticated ownership or the existing admin/moderator JWT role.
begin;

create table if not exists public.workshops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  services text[] not null default '{}'::text[] check (cardinality(services) <= 30),
  address text not null check (char_length(btrim(address)) between 5 and 300),
  city text not null check (char_length(btrim(city)) between 2 and 100),
  state text not null default 'Tamil Nadu' check (char_length(btrim(state)) between 2 and 100),
  pincode text not null check (pincode ~ '^[0-9]{6}$'),
  phone text not null check (phone ~ '^[+0-9() -]{7,25}$'),
  whatsapp text check (whatsapp is null or whatsapp ~ '^[+0-9() -]{7,25}$'),
  website_url text check (website_url is null or website_url ~ '^https://'),
  opening_hours text not null default '' check (char_length(opening_hours) <= 500),
  status text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  is_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workshops_location_idx on public.workshops(state, city, pincode) where status='approved';
create index if not exists workshops_owner_idx on public.workshops(owner_id, created_at desc);

create table if not exists public.workshop_reviews (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  body text not null check (char_length(btrim(body)) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending','published','hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workshop_id, reviewer_id)
);
create index if not exists workshop_reviews_public_idx on public.workshop_reviews(workshop_id, created_at desc) where status='published';

create table if not exists public.workshop_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  workshop_id uuid references public.workshops(id) on delete cascade,
  review_id uuid references public.workshop_reviews(id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 10 and 1500),
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  admin_note text not null default '' check (char_length(admin_note) <= 2000),
  created_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  check ((workshop_id is not null) <> (review_id is not null))
);
create index if not exists workshop_reports_open_idx on public.workshop_reports(created_at asc) where status in ('open','investigating');

create table if not exists public.community_admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (char_length(btrim(action)) between 2 and 80),
  target_type text not null check (char_length(btrim(target_type)) between 2 and 80),
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists community_admin_audit_created_idx on public.community_admin_audit(created_at desc);

alter table public.workshops enable row level security;
alter table public.workshop_reviews enable row level security;
alter table public.workshop_reports enable row level security;
alter table public.community_admin_audit enable row level security;

drop policy if exists workshops_public_approved_read on public.workshops;
create policy workshops_public_approved_read on public.workshops for select to anon, authenticated using (status='approved');
drop policy if exists workshops_owner_read on public.workshops;
create policy workshops_owner_read on public.workshops for select to authenticated using (owner_id=auth.uid());
drop policy if exists workshops_owner_insert_pending on public.workshops;
create policy workshops_owner_insert_pending on public.workshops for insert to authenticated with check (owner_id=auth.uid() and status='pending' and is_verified=false);
drop policy if exists workshops_owner_update_pending on public.workshops;
create policy workshops_owner_update_pending on public.workshops for update to authenticated using (owner_id=auth.uid() and status in ('pending','rejected')) with check (owner_id=auth.uid() and status in ('pending','rejected') and is_verified=false);
drop policy if exists workshops_admin_all on public.workshops;
create policy workshops_admin_all on public.workshops for all to authenticated using (public.forum_is_moderator()) with check (public.forum_is_moderator());

drop policy if exists workshop_reviews_public_read on public.workshop_reviews;
create policy workshop_reviews_public_read on public.workshop_reviews for select to anon, authenticated using (status='published');
drop policy if exists workshop_reviews_owner_read on public.workshop_reviews;
create policy workshop_reviews_owner_read on public.workshop_reviews for select to authenticated using (reviewer_id=auth.uid());
drop policy if exists workshop_reviews_owner_insert on public.workshop_reviews;
create policy workshop_reviews_owner_insert on public.workshop_reviews for insert to authenticated with check (reviewer_id=auth.uid() and status='pending');
drop policy if exists workshop_reviews_owner_update_pending on public.workshop_reviews;
create policy workshop_reviews_owner_update_pending on public.workshop_reviews for update to authenticated using (reviewer_id=auth.uid() and status='pending') with check (reviewer_id=auth.uid() and status='pending');
drop policy if exists workshop_reviews_admin_all on public.workshop_reviews;
create policy workshop_reviews_admin_all on public.workshop_reviews for all to authenticated using (public.forum_is_moderator()) with check (public.forum_is_moderator());

drop policy if exists workshop_reports_insert_own on public.workshop_reports;
create policy workshop_reports_insert_own on public.workshop_reports for insert to authenticated with check (reporter_id=auth.uid() and status='open' and resolved_by is null and resolved_at is null);
drop policy if exists workshop_reports_read_own on public.workshop_reports;
create policy workshop_reports_read_own on public.workshop_reports for select to authenticated using (reporter_id=auth.uid());
drop policy if exists workshop_reports_admin_all on public.workshop_reports;
create policy workshop_reports_admin_all on public.workshop_reports for all to authenticated using (public.forum_is_moderator()) with check (public.forum_is_moderator());

drop policy if exists community_admin_audit_admin_only on public.community_admin_audit;
create policy community_admin_audit_admin_only on public.community_admin_audit for all to authenticated using (public.forum_is_moderator()) with check (public.forum_is_moderator());

grant select on public.workshops to anon, authenticated;
grant insert, update on public.workshops to authenticated;
grant select on public.workshop_reviews to anon, authenticated;
grant insert, update on public.workshop_reviews to authenticated;
grant select, insert on public.workshop_reports to authenticated;
grant select, insert, update, delete on public.community_admin_audit to authenticated;
grant update, delete on public.workshop_reports to authenticated;
grant update, delete on public.workshops, public.workshop_reviews to authenticated;

commit;