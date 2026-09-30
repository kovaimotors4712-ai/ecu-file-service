-- ECU FILE SERVICE INDIA customer/order/private-file schema.
-- Review and apply to the target Supabase project only after approval.

create extension if not exists pgcrypto with schema extensions;
create type public.order_status as enum ('New', 'File Review', 'Processing', 'Completed');
create type public.file_kind as enum ('original', 'processed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default extensions.gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  status public.order_status not null default 'New',
  category text not null check (category in ('ECU', 'AIRBAG', 'DASHBOARD')),
  vehicle_brand text not null check (length(trim(vehicle_brand)) between 1 and 100),
  vehicle_type text not null check (length(trim(vehicle_type)) between 1 and 100),
  vehicle_model text not null check (length(trim(vehicle_model)) between 1 and 160),
  vehicle_year smallint check (vehicle_year is null or vehicle_year between 1950 and 2100),
  ecu_manufacturer text check (ecu_manufacturer is null or length(ecu_manufacturer) <= 100),
  ecu_model text check (ecu_model is null or length(ecu_model) <= 120),
  reading_tool text check (reading_tool is null or length(reading_tool) <= 100),
  selected_services text[] not null check (
    cardinality(selected_services) > 0 and selected_services <@ array[
      'DTC OFF', 'DPF OFF', 'AdBlue / SCR OFF', 'EGR OFF', 'O2 Remove',
      'EVAP OFF', 'Decat', 'IMMO OFF', 'Speed Limit', 'Custom Request'
    ]::text[]
  ),
  notes text check (notes is null or length(notes) <= 4000),
  contact_name text not null check (length(trim(contact_name)) between 1 and 120),
  contact_phone text not null check (length(trim(contact_phone)) between 5 and 40),
  contact_email text check (contact_email is null or length(contact_email) <= 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, customer_id)
);

create table public.order_files (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  kind public.file_kind not null,
  bucket_id text not null default 'private-ecu-files' check (bucket_id = 'private-ecu-files'),
  object_path text not null unique check (object_path !~ '(^/|\.\.|\\)'),
  original_name text not null check (length(original_name) between 1 and 255),
  mime_type text,
  size_bytes bigint not null check (size_bytes between 0 and 52428800),
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint order_files_order_owner_fk foreign key (order_id, owner_id)
    references public.orders(id, customer_id) on delete cascade
);
create index orders_customer_created_idx on public.orders (customer_id, created_at desc);
create index orders_status_created_idx on public.orders (status, created_at desc);
create index order_files_order_idx on public.order_files (order_id, created_at);

create or replace function public.is_admin()
returns boolean language sql stable security invoker set search_path = ''
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'role' = 'admin', false); $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end; $$;

create or replace function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function public.enforce_order_status_transition()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not public.is_admin() then
      raise exception 'Only an admin can change order status' using errcode = '42501';
    end if;
    if not (
      (old.status = 'New' and new.status = 'File Review') or
      (old.status = 'File Review' and new.status = 'Processing') or
      (old.status = 'Processing' and new.status = 'Completed')
    ) then
      raise exception 'Invalid order status transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
    if new.status = 'Completed' and not exists (
      select 1 from public.order_files f where f.order_id = old.id and f.kind = 'processed'
    ) then
      raise exception 'Add a processed file before completing the order' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger auth_user_profile_created after insert on auth.users
  for each row execute function public.create_profile_for_auth_user();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger orders_updated_at before update on public.orders
  for each row execute function public.touch_updated_at();
create trigger orders_status_transition before update on public.orders
  for each row execute function public.enforce_order_status_transition();

alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.order_files enable row level security;

create policy "Customers read own profile; admins read all" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy "Customers update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "Admins manage profiles" on public.profiles
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "Customers read own orders; admins read all" on public.orders
  for select to authenticated using (customer_id = (select auth.uid()) or (select public.is_admin()));
create policy "Customers create own new orders" on public.orders
  for insert to authenticated with check (customer_id = (select auth.uid()) and status = 'New');
create policy "Admins create orders" on public.orders
  for insert to authenticated with check ((select public.is_admin()));
create policy "Admins update orders" on public.orders
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "Customers read own order files; admins read all" on public.order_files
  for select to authenticated using (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "Customers register original files for own new orders" on public.order_files
  for insert to authenticated with check (
    owner_id = (select auth.uid()) and uploaded_by = (select auth.uid()) and kind = 'original'
    and split_part(object_path, '/', 1) = (select auth.uid())::text
    and split_part(object_path, '/', 2) = order_id::text
    and split_part(object_path, '/', 3) = 'original'
    and exists (select 1 from public.orders o
      where o.id = order_id and o.customer_id = (select auth.uid()) and o.status = 'New')
  );
create policy "Admins manage order files" on public.order_files
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

revoke all on public.profiles, public.orders, public.order_files from anon, public;
grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, phone) on public.profiles to authenticated;
grant select, insert, update on public.orders to authenticated;
grant select, insert, update, delete on public.order_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('private-ecu-files', 'private-ecu-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

create policy "Customers read files belonging to own orders; admins read all"
  on storage.objects for select to authenticated using (
    bucket_id = 'private-ecu-files' and (
      (split_part(name, '/', 1) = (select auth.uid())::text and exists (
        select 1 from public.orders o
        where o.id::text = split_part(name, '/', 2) and o.customer_id = (select auth.uid())
      )) or (select public.is_admin())
    )
  );
create policy "Customers upload originals to own new orders"
  on storage.objects for insert to authenticated with check (
    bucket_id = 'private-ecu-files'
    and split_part(name, '/', 1) = (select auth.uid())::text
    and split_part(name, '/', 3) = 'original'
    and split_part(name, '/', 4) <> ''
    and exists (select 1 from public.orders o
      where o.id::text = split_part(name, '/', 2)
        and o.customer_id = (select auth.uid()) and o.status = 'New')
  );
create policy "Admins manage private ECU files"
  on storage.objects for all to authenticated
  using (bucket_id = 'private-ecu-files' and (select public.is_admin()))
  with check (bucket_id = 'private-ecu-files' and (select public.is_admin()));
