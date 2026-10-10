-- Migration: [`supabase/migrations/20261009_fix_rls_and_constraints.sql`](supabase/migrations/20261009_fix_rls_and_constraints.sql:1)
-- Description: Idempotent fix for RLS, column privileges, and constraints for notifications and order messages.
-- NOTE: Production SQL was NOT executed. This script is wrapped in a transaction block (BEGIN; ... COMMIT;)
-- and executes with RLS continuously enabled (without any DISABLE ROW LEVEL SECURITY period).

BEGIN;

-- 1. Composite unique index on public.orders(id, customer_id) for composite foreign key reference without duplication
create unique index if not exists orders_id_customer_id_key on public.orders(id, customer_id);

-- 2. Complete CREATE TABLE IF NOT EXISTS for public.notifications matching columns in server.js and auth.js
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete cascade not null,
  order_id uuid references public.orders(id) on delete cascade not null,
  message text not null,
  is_read boolean default false,
  created_at timestamptz default now()
);

-- Safely handle existing table: migrate legacy checkout_intents order_id reference to orders(id), check for orphans, and ensure foreign key
do $$
declare
  v_orphan_count integer;
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'notifications') then
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'checkout_intents') then
      update public.notifications n
      set order_id = c.order_id
      from public.checkout_intents c
      where n.order_id = c.id
        and c.order_id is not null;
    end if;

    select count(*) into v_orphan_count
    from public.notifications n
    where not exists (
      select 1 from public.orders o where o.id = n.order_id
    );

    if v_orphan_count > 0 then
      raise exception 'Migration aborted: found % orphan notification(s) with order_id not present in public.orders.', v_orphan_count;
    end if;

    alter table public.notifications drop constraint if exists notifications_order_id_fkey;
    if not exists (
      select 1 from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
      where tc.table_schema = 'public' and tc.table_name = 'notifications' and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'order_id'
    ) then
      alter table public.notifications
        add constraint notifications_order_id_fkey foreign key (order_id) references public.orders(id) on delete cascade;
    end if;
  end if;
end $$;

create index if not exists notifications_customer_id_idx on public.notifications(customer_id, created_at desc);

-- 3. Complete CREATE TABLE IF NOT EXISTS for public.order_messages matching columns in server.js and auth.js
create table if not exists public.order_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null,
  customer_id uuid not null,
  sender_type text not null check (sender_type in ('customer', 'admin')),
  message text not null check (length(trim(message)) between 1 and 2000),
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  constraint order_messages_order_owner_fk foreign key (order_id, customer_id)
    references public.orders(id, customer_id) on delete cascade
);

-- Safely handle existing order_messages table constraints
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'order_messages') then
    alter table public.order_messages drop constraint if exists order_messages_order_owner_fk;
    if not exists (
      select 1 from information_schema.table_constraints
      where table_schema = 'public' and table_name = 'order_messages' and constraint_name = 'order_messages_order_owner_fk'
    ) then
      alter table public.order_messages
        add constraint order_messages_order_owner_fk foreign key (order_id, customer_id)
        references public.orders(id, customer_id) on delete cascade;
    end if;
  end if;
end $$;

create index if not exists order_messages_order_created_idx on public.order_messages(order_id, created_at asc);
create index if not exists order_messages_customer_unread_idx on public.order_messages(customer_id, is_read)
  where sender_type = 'admin' and is_read = false;

-- 4. Hardened RLS and Column Restrictions for public.notifications
-- Ensure RLS is enabled without any intermediate disablement
alter table public.notifications enable row level security;

-- Explicit cleanup of all existing/conflicting policies across migration history
drop policy if exists "Customers read own notifications" on public.notifications;
drop policy if exists "Customers mark own notifications as read" on public.notifications;
drop policy if exists "Customers update own notifications" on public.notifications;
drop policy if exists "Admins manage notifications" on public.notifications;

create policy "Customers read own notifications" on public.notifications
  for select to authenticated using (auth.uid() = customer_id);

create policy "Customers update own notifications" on public.notifications
  for update to authenticated using (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);

create policy "Admins manage notifications" on public.notifications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Column privileges for public.notifications: restrict authenticated to select and update only is_read
revoke all on public.notifications from public, anon, authenticated;
grant select, update (is_read) on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- 5. Hardened RLS and Column/Operation Restrictions for public.order_messages
-- Ensure RLS is enabled without any intermediate disablement
alter table public.order_messages enable row level security;

-- Explicit cleanup of all existing/conflicting policies across migration history
drop policy if exists "Customers manage own order messages" on public.order_messages;
drop policy if exists "Customers select own order messages" on public.order_messages;
drop policy if exists "Customers insert own order messages" on public.order_messages;
drop policy if exists "Customers update own order messages" on public.order_messages;
drop policy if exists "Admins manage order messages" on public.order_messages;

create policy "Customers select own order messages" on public.order_messages
  for select to authenticated
  using (auth.uid() = customer_id);

create policy "Customers insert own order messages" on public.order_messages
  for insert to authenticated
  with check (auth.uid() = customer_id and sender_type = 'customer');

create policy "Customers update own order messages" on public.order_messages
  for update to authenticated
  using (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);

create policy "Admins manage order messages" on public.order_messages
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Explicit least-privilege GRANT/REVOKE statements for public.order_messages
revoke all on public.order_messages from public, anon, authenticated;
grant select, insert, update (is_read) on public.order_messages to authenticated;
grant all on public.order_messages to service_role;

COMMIT;
