-- ECU File Service India
-- Final application migration for customer orders, dual-gateway payments,
-- durable checkout intents, realtime, email outbox, and private storage.
-- Non-destructive and safe to re-run.

-- ------------------------------------------------------------
-- 1. Order status values
-- ------------------------------------------------------------

do $$
declare
  label text;
begin
  if exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'order_status') then
    foreach label in array array['Possible','Not Possible','Payment Pending','Cancelled'] loop
      if not exists (
        select 1
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
        where t.typnamespace = 'public'::regnamespace
          and t.typname = 'order_status'
          and e.enumlabel = label
      ) then
        execute format('alter type public.order_status add value %L', label);
      end if;
    end loop;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. Provider-neutral payment fields
-- Keep legacy Razorpay fields nullable for compatibility only.
-- ------------------------------------------------------------

alter table public.orders
  add column if not exists payment_provider text,
  add column if not exists provider_order_id text,
  add column if not exists provider_payment_id text,
  add column if not exists payment_status text not null default 'PENDING',
  add column if not exists paid_at timestamptz,
  add column if not exists payment_request_sha256 text,
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_payment_id text,
  add column if not exists verification_amount_paise bigint;

alter table public.orders drop constraint if exists orders_payment_provider_check;
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders drop constraint if exists orders_payment_fields_check;
alter table public.orders drop constraint if exists orders_payment_provider_fields_check;
alter table public.orders drop constraint if exists orders_payment_consistency_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_payment_provider_check') then
    alter table public.orders add constraint orders_payment_provider_check
      check (payment_provider is null or payment_provider in ('razorpay','paypal'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_payment_status_check') then
    alter table public.orders add constraint orders_payment_status_check
      check (payment_status in ('PENDING','PAID','EXPIRED','CANCELLED'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_payment_consistency_check') then
    alter table public.orders add constraint orders_payment_consistency_check
      check (
        (payment_status = 'PAID'
          and payment_provider in ('razorpay','paypal')
          and provider_order_id is not null
          and provider_payment_id is not null
          and paid_at is not null
          and payment_request_sha256 ~ '^[a-f0-9]{64}$'
          and verification_amount_paise is not null
          and verification_amount_paise > 0)
        or
        (payment_status <> 'PAID')
      );
  end if;
end $$;

create unique index if not exists orders_provider_order_id_uidx
  on public.orders(provider_order_id) where provider_order_id is not null;
create unique index if not exists orders_provider_payment_id_uidx
  on public.orders(provider_payment_id) where provider_payment_id is not null;
create index if not exists orders_payment_status_created_idx
  on public.orders(payment_status, created_at desc);

-- Category-specific data integrity: Airbag/Dashboard must not carry ECU-only fields.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_category_fields_check') then
    alter table public.orders add constraint orders_category_fields_check check (
      (category = 'ECU')
      or
      (category in ('AIRBAG','DASHBOARD')
       and vehicle_year is not null
       and ecu_manufacturer is null
       and ecu_model is null
       and reading_tool is null)
    );
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. Explicit status workflow
-- Any listed operational status is selectable by an authenticated admin.
-- Completed always requires a processed file.
-- Terminal states are not accidentally reopened by clients because only admins
-- can change status; the application intentionally permits an admin to correct a status.
-- ------------------------------------------------------------

create or replace function public.enforce_order_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not public.is_admin() then
      raise exception 'Only an admin can change order status' using errcode='42501';
    end if;
    if new.status = 'Completed' and not exists (
      select 1 from public.order_files f
      where f.order_id = old.id and f.kind = 'processed'
    ) then
      raise exception 'Add a processed file before completing the order' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 4. Durable checkout intents
-- ------------------------------------------------------------

create table if not exists public.checkout_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  status text not null default 'DRAFT' check (status in ('DRAFT','FILE_STAGED','PAYMENT_PENDING','PAID','EXPIRED','CANCELLED')),
  payment_status text not null default 'PENDING' check (payment_status in ('PENDING','PAID','EXPIRED','CANCELLED')),
  payment_provider text check (payment_provider is null or payment_provider in ('razorpay','paypal')),
  provider_order_id text,
  provider_payment_id text,
  request_json jsonb not null,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  original_name text not null check (length(original_name) between 1 and 255),
  original_mime text not null default 'application/octet-stream',
  original_size bigint not null check (original_size between 1 and 52428800),
  original_sha256 text not null check (original_sha256 ~ '^[a-f0-9]{64}$'),
  storage_path text not null,
  amount_paise bigint not null check (amount_paise between 1 and 100000000),
  currency text not null default 'INR' check (currency = 'INR'),
  file_staged_at timestamptz,
  expires_at timestamptz not null,
  paid_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, customer_id),
  constraint checkout_intents_storage_path_check check (
    storage_path = 'content/' || original_sha256
  )
);

alter table public.checkout_intents
  add column if not exists order_id uuid references public.orders(id) on delete set null;

alter table public.checkout_intents drop constraint if exists checkout_intents_storage_path_check;
alter table public.checkout_intents add constraint checkout_intents_storage_path_check
  check (storage_path = 'content/' || original_sha256);

create index if not exists checkout_intents_customer_updated_idx
  on public.checkout_intents(customer_id, updated_at desc);
create unique index if not exists checkout_intents_order_id_uidx
  on public.checkout_intents(order_id) where order_id is not null;
create index if not exists checkout_intents_expiry_idx
  on public.checkout_intents(status, expires_at);
create unique index if not exists checkout_intents_active_hash_uidx
  on public.checkout_intents(customer_id, request_sha256)
  where status in ('DRAFT','FILE_STAGED','PAYMENT_PENDING');
create unique index if not exists checkout_intents_provider_order_uidx
  on public.checkout_intents(provider_order_id) where provider_order_id is not null;
create unique index if not exists checkout_intents_provider_payment_uidx
  on public.checkout_intents(provider_payment_id) where provider_payment_id is not null;

drop trigger if exists checkout_intents_updated_at on public.checkout_intents;
create trigger checkout_intents_updated_at
  before update on public.checkout_intents
  for each row execute function public.touch_updated_at();

alter table public.checkout_intents enable row level security;

 drop policy if exists "Customers read own checkout intents" on public.checkout_intents;
create policy "Customers read own checkout intents"
  on public.checkout_intents for select to authenticated
  using (customer_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "Customers create own draft checkout intents" on public.checkout_intents;
drop policy if exists "Customers advance own checkout intents" on public.checkout_intents;

 drop policy if exists "Admins manage checkout intents" on public.checkout_intents;
create policy "Admins manage checkout intents"
  on public.checkout_intents for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.checkout_intents from anon, public;
grant select, insert, update on public.checkout_intents to authenticated;

-- ------------------------------------------------------------
-- 5. Close the direct customer order/file bypasses.
-- Customer orders are finalized only by the verified payment RPC.
-- ------------------------------------------------------------

drop policy if exists "Customers create own new orders" on public.orders;
grant insert on public.orders to authenticated;


-- Same object may be referenced by multiple orders when the SHA-256 is identical.
-- Remove the base-table object_path UNIQUE constraint if present.
alter table public.order_files drop constraint if exists order_files_object_path_key;
create index if not exists order_files_object_path_idx on public.order_files(object_path);
create unique index if not exists order_files_one_original_per_order_uidx
  on public.order_files(order_id) where kind = 'original';

grant insert, update, delete on public.order_files to authenticated;

-- ------------------------------------------------------------
-- 6. Private Storage policies for staged checkout files + final order files.
-- ------------------------------------------------------------

 drop policy if exists "Customers upload originals to own new orders" on storage.objects;
 drop policy if exists "Customers upload originals to own paid orders" on storage.objects;
 drop policy if exists "Customers upload own checkout files" on storage.objects;
create policy "Customers upload own checkout files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'private-ecu-files'
    and split_part(name,'/',1) = 'content'
    and split_part(name,'/',2) ~ '^[a-f0-9]{64}$'
    and exists (
      select 1 from public.checkout_intents c
      where c.customer_id = (select auth.uid())
        and c.storage_path = name
        and c.status in ('DRAFT','FILE_STAGED','PAYMENT_PENDING')
        and c.payment_status = 'PENDING'
        and c.expires_at > now()
    )
  );

drop policy if exists "Customers read files belonging to own orders; admins read all" on storage.objects;
drop policy if exists "Customers read own checkout and order files" on storage.objects;
create policy "Customers read own checkout and order files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'private-ecu-files'
    and (
      (
        split_part(name,'/',1) = 'content'
        and exists (
          select 1 from public.checkout_intents c
          where c.customer_id = (select auth.uid())
            and c.storage_path = name
            and c.status in ('DRAFT','FILE_STAGED','PAYMENT_PENDING','PAID','EXPIRED','CANCELLED')
        )
      )
      or
      (
        exists (
          select 1 from public.order_files f
          where f.owner_id = (select auth.uid())
            and f.bucket_id = 'private-ecu-files'
            and f.object_path = name
        )
      )
      or (select public.is_admin())
    )
  );

drop policy if exists "Admins manage private ECU files" on storage.objects;
create policy "Admins manage private ECU files"
  on storage.objects for all to authenticated
  using (bucket_id='private-ecu-files' and (select public.is_admin()))
  with check (bucket_id='private-ecu-files' and (select public.is_admin()));

-- ------------------------------------------------------------
-- 7. Verified, provider-neutral paid-order finalizer.
-- Payment provider verification happens in server.js, then this RPC is the only
-- path that converts a checkout intent into a paid customer order.
-- ------------------------------------------------------------

create extension if not exists supabase_vault with schema vault;

do $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault is unavailable: expected vault.decrypted_secrets';
  end if;
end $$;

create or replace function public.efsi_finalize_paid_checkout(
  p_intent_id uuid,
  p_payment_provider text,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_amount_paise bigint,
  p_currency text,
  p_paid_at timestamptz,
  p_payment_proof text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid := auth.uid();
  v_secret text;
  v_expected_proof text;
  v_intent public.checkout_intents%rowtype;
  v_order_id uuid;
  v_request jsonb;
  v_category text;
  v_vehicle_year smallint;
  v_original_id uuid;
begin
  if v_customer_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if p_payment_provider not in ('razorpay','paypal') then
    raise exception 'Unsupported payment provider' using errcode='22023';
  end if;
  if p_amount_paise is null or p_amount_paise < 1 or p_amount_paise > 100000000 then
    raise exception 'Invalid payment amount' using errcode='22023';
  end if;
  if p_currency <> 'INR' then
    raise exception 'Invalid payment currency' using errcode='22023';
  end if;
  if p_provider_order_id is null or length(p_provider_order_id) < 3 or length(p_provider_order_id) > 128
     or p_provider_payment_id is null or length(p_provider_payment_id) < 3 or length(p_provider_payment_id) > 128
     or p_payment_proof !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid verified payment data' using errcode='22023';
  end if;

  select * into v_intent
  from public.checkout_intents
  where id = p_intent_id and customer_id = v_customer_id
  for update;

  if not found then
    raise exception 'Checkout intent not found' using errcode='P0002';
  end if;

  if v_intent.payment_status = 'PAID' and v_intent.status = 'PAID' then
    if v_intent.payment_provider = p_payment_provider
       and v_intent.provider_order_id = p_provider_order_id
       and v_intent.provider_payment_id = p_provider_payment_id
       and v_intent.amount_paise = p_amount_paise then
      v_order_id := v_intent.order_id;
      if v_order_id is null then
        select id into v_order_id from public.orders where provider_order_id = p_provider_order_id limit 1;
      end if;
      if v_order_id is not null then return v_order_id; end if;
    end if;
    raise exception 'Checkout intent was already paid with different payment references' using errcode='23505';
  end if;

  if v_intent.status not in ('FILE_STAGED','PAYMENT_PENDING')
     or v_intent.expires_at <= now()
     or v_intent.payment_status <> 'PENDING' then
    raise exception 'Checkout intent is not payable' using errcode='40900';
  end if;
  if v_intent.payment_provider is not null and v_intent.payment_provider <> p_payment_provider then
    raise exception 'Payment provider does not match this checkout' using errcode='22023';
  end if;
  if v_intent.provider_order_id is not null and v_intent.provider_order_id <> p_provider_order_id then
    raise exception 'Provider order does not match this checkout' using errcode='22023';
  end if;
  if v_intent.amount_paise <> p_amount_paise or v_intent.currency <> p_currency then
    raise exception 'Payment amount or currency does not match this checkout' using errcode='22023';
  end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id='private-ecu-files' and name=v_intent.storage_path
  ) then
    raise exception 'Original file is not staged in private storage' using errcode='P0002';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name='efsi_payment_gate_proof_secret'
  limit 1;
  if v_secret is null or length(v_secret) < 32 then
    raise exception 'Payment verification is not configured' using errcode='55000';
  end if;

  v_expected_proof := encode(extensions.hmac(
    convert_to(
      'EFSI_PAYMENT_CONFIRMATION_V2|' ||
      v_customer_id::text || '|' ||
      v_intent.id::text || '|' ||
      p_payment_provider || '|' ||
      p_provider_order_id || '|' ||
      p_provider_payment_id || '|' ||
      p_amount_paise::text || '|' ||
      v_intent.request_sha256,
      'UTF8'
    ),
    convert_to(v_secret,'UTF8'),
    'sha256'
  ), 'hex');

  if lower(p_payment_proof) <> v_expected_proof then
    raise exception 'Payment server proof is invalid' using errcode='42501';
  end if;

  if exists (
    select 1 from public.orders
    where provider_order_id = p_provider_order_id
       or provider_payment_id = p_provider_payment_id
  ) then
    raise exception 'Payment reference already used' using errcode='23505';
  end if;

  v_request := v_intent.request_json;
  v_category := v_request ->> 'category';
  v_vehicle_year := nullif(v_request ->> 'vehicleYear','')::smallint;

  insert into public.orders (
    id, customer_id, status, category, vehicle_brand, vehicle_type, vehicle_model,
    vehicle_year, ecu_manufacturer, ecu_model, reading_tool, selected_services,
    notes, contact_name, contact_phone, contact_email,
    payment_status, payment_provider, provider_order_id, provider_payment_id,
    verification_amount_paise, payment_request_sha256, paid_at,
    razorpay_order_id, razorpay_payment_id
  ) values (
    extensions.gen_random_uuid(), v_customer_id, 'New', v_category,
    v_request ->> 'vehicleBrand', v_request ->> 'vehicleType', v_request ->> 'vehicleModel',
    v_vehicle_year,
    case when v_category='ECU' then nullif(v_request ->> 'ecuManufacturer','') else null end,
    case when v_category='ECU' then nullif(v_request ->> 'ecuModel','') else null end,
    case when v_category='ECU' then nullif(v_request ->> 'readingTool','') else null end,
    array(select jsonb_array_elements_text(v_request -> 'selectedServices')),
    nullif(v_request ->> 'notes',''),
    v_request ->> 'contactName', v_request ->> 'contactPhone', nullif(v_request ->> 'contactEmail',''),
    'PAID', p_payment_provider, p_provider_order_id, p_provider_payment_id,
    p_amount_paise, v_intent.request_sha256, coalesce(p_paid_at, now()),
    case when p_payment_provider='razorpay' then p_provider_order_id else null end,
    case when p_payment_provider='razorpay' then p_provider_payment_id else null end
  ) returning id into v_order_id;

  insert into public.order_files (
    order_id, owner_id, kind, bucket_id, object_path,
    original_name, mime_type, size_bytes, uploaded_by
  ) values (
    v_order_id, v_customer_id, 'original', 'private-ecu-files', v_intent.storage_path,
    v_intent.original_name, v_intent.original_mime, v_intent.original_size, v_customer_id
  ) returning id into v_original_id;

  update public.checkout_intents
  set status='PAID', payment_status='PAID', order_id=v_order_id, payment_provider=p_payment_provider,
      provider_order_id=p_provider_order_id, provider_payment_id=p_provider_payment_id,
      paid_at=coalesce(p_paid_at, now()), updated_at=now()
  where id=v_intent.id and customer_id=v_customer_id;

  return v_order_id;
end;
$$;

revoke all on function public.efsi_finalize_paid_checkout(uuid,text,text,text,bigint,text,timestamptz,text) from public, anon;
grant execute on function public.efsi_finalize_paid_checkout(uuid,text,text,text,bigint,text,timestamptz,text) to authenticated;

-- ------------------------------------------------------------
-- 8. Notification outbox + DB trigger
-- ------------------------------------------------------------

create table if not exists public.notification_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  event_type text not null check (event_type in ('new_order','paid_order')),
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','RETRY','FAILED')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 20),
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id,event_type)
);

create index if not exists notification_outbox_queue_idx
  on public.notification_outbox(status, next_attempt_at, created_at);

drop trigger if exists notification_outbox_updated_at on public.notification_outbox;
create trigger notification_outbox_updated_at
  before update on public.notification_outbox
  for each row execute function public.touch_updated_at();

alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated, public;
-- Server worker uses the service-role key, not customer tokens.

-- Queue events from the verified paid-order transaction. A newly finalized order is
-- both a new submission and a paid submission. The unique constraint prevents duplicates.
create or replace function public.enqueue_admin_order_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notification_outbox(order_id,event_type)
      values (new.id,'new_order')
      on conflict (order_id,event_type) do nothing;
    if new.payment_status = 'PAID' then
      insert into public.notification_outbox(order_id,event_type)
        values (new.id,'paid_order')
        on conflict (order_id,event_type) do nothing;
    end if;
    return new;
  end if;

  if new.payment_status is distinct from old.payment_status and new.payment_status = 'PAID' then
    insert into public.notification_outbox(order_id,event_type)
      values (new.id,'paid_order')
      on conflict (order_id,event_type) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_notification_outbox on public.orders;
create trigger orders_notification_outbox
  after insert or update of payment_status on public.orders
  for each row execute function public.enqueue_admin_order_notifications();

-- ------------------------------------------------------------
-- 9. Realtime publication: add only the tables used by the UI.
-- Never drop or recreate the existing Supabase realtime publication.
-- ------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='orders') then
      alter publication supabase_realtime add table public.orders;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='order_files') then
      alter publication supabase_realtime add table public.order_files;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='checkout_intents') then
      alter publication supabase_realtime add table public.checkout_intents;
    end if;
  end if;
end $$;

-- ------------------------------------------------------------
-- 10. Helpful maintenance RPC. The web worker may call this with service-role auth.
-- It marks only abandoned checkout intents; it does not mutate order statuses.
-- ------------------------------------------------------------

create or replace function public.efsi_cleanup_expired_checkout_intents()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.checkout_intents
  set status='EXPIRED', payment_status='EXPIRED', updated_at=now()
  where status in ('DRAFT','FILE_STAGED','PAYMENT_PENDING')
    and expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.efsi_cleanup_expired_checkout_intents() from public, anon, authenticated;
-- Intentionally not granted to browser roles. Server service-role execution bypasses RLS.

-- ------------------------------------------------------------
-- 11. Final grants / policy cleanup.
-- ------------------------------------------------------------

-- Customers can read their own orders and files, but cannot create or mutate paid orders directly.
-- Admins keep the existing orders update policy.

-- Keep a customer read policy for order_files after the insert revoke.
drop policy if exists "Customers register original files for own new orders" on public.order_files;
drop policy if exists "Customers register original files for own paid orders" on public.order_files;
drop policy if exists "Customers create own orders" on public.orders;

-- Ensure private bucket exists and remains private.
insert into storage.buckets(id,name,public,file_size_limit)
values('private-ecu-files','private-ecu-files',false,52428800)
on conflict(id) do update
set public=false, file_size_limit=52428800;

-- Note: storage cleanup of staged files is performed by the server service-role worker
-- after expiry; browser users never receive a delete permission.

-- No destructive realtime/publication operation is allowed in this migration.

