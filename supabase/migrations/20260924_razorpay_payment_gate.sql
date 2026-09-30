-- PROPOSED, NOT APPLIED.
-- Closes the direct customer order/file-upload bypass before enabling Razorpay.
-- Before use, generate a separate random PAYMENT_GATE_PROOF_SECRET locally and
-- save that same value in Supabase Vault as efsi_payment_gate_proof_secret.
-- The proof secret must be at least 32 characters, matching server.js.
-- This is NOT the Razorpay Key Secret. Never put either value in this file.
-- Apply this whole file as one transaction. Errors roll all changes back.

begin;

create extension if not exists supabase_vault with schema vault;

do $$
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault is unavailable: expected vault.decrypted_secrets';
  end if;
end $$;

alter table public.orders
  add column if not exists payment_status text not null default 'PENDING',
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_payment_id text,
  add column if not exists verification_amount_paise bigint,
  add column if not exists payment_request_sha256 text,
  add column if not exists paid_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_payment_status_check') then
    alter table public.orders add constraint orders_payment_status_check
      check (payment_status in ('PENDING', 'PAID'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_payment_fields_check') then
    alter table public.orders add constraint orders_payment_fields_check check (
      (payment_status = 'PENDING' and razorpay_order_id is null and razorpay_payment_id is null and verification_amount_paise is null and payment_request_sha256 is null and paid_at is null)
      or
      (payment_status = 'PAID' and razorpay_order_id is not null and razorpay_payment_id is not null and verification_amount_paise > 0 and payment_request_sha256 ~ '^[a-f0-9]{64}$' and paid_at is not null)
    );
  end if;
end $$;

create unique index if not exists orders_razorpay_order_id_uidx
  on public.orders (razorpay_order_id) where razorpay_order_id is not null;
create unique index if not exists orders_razorpay_payment_id_uidx
  on public.orders (razorpay_payment_id) where razorpay_payment_id is not null;

-- Customers must use the paid-order RPC; admins retain their existing policy.
drop policy if exists "Customers create own new orders" on public.orders;

create or replace function public.efsi_create_paid_order(
  p_order_id uuid,
  p_payment_order_id text,
  p_payment_id text,
  p_amount_paise bigint,
  p_request_sha256 text,
  p_payment_proof text,
  p_order_json text
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
  v_request_hash text;
  v_order jsonb;
  v_existing public.orders%rowtype;
begin
  if v_customer_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_amount_paise is null or p_amount_paise < 1 or p_amount_paise > 100000000
     or p_request_sha256 !~ '^[a-f0-9]{64}$'
     or p_payment_order_id !~ '^order_[A-Za-z0-9]+$'
     or p_payment_id !~ '^pay_[A-Za-z0-9]+$'
     or p_payment_proof !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid verified payment data' using errcode = '22023';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(p_order_json, 'UTF8'), 'sha256'), 'hex');
  if v_request_hash <> p_request_sha256 then
    raise exception 'Request hash mismatch' using errcode = '22023';
  end if;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'efsi_payment_gate_proof_secret' limit 1;
  if v_secret is null or length(v_secret) < 32 then
    raise exception 'Payment verification is not configured' using errcode = '55000';
  end if;
  v_expected_proof := encode(extensions.hmac(
    convert_to('EFSI_PAYMENT_CONFIRMATION_V1|' || v_customer_id::text || '|' || p_order_id::text || '|' || p_payment_order_id || '|' || p_payment_id || '|' || p_amount_paise::text || '|' || p_request_sha256, 'UTF8'),
    convert_to(v_secret, 'UTF8'), 'sha256'
  ), 'hex');
  if lower(p_payment_proof) <> v_expected_proof then
    raise exception 'Payment server proof is invalid' using errcode = '42501';
  end if;

  select * into v_existing from public.orders where id = p_order_id;
  if found then
    if v_existing.customer_id = v_customer_id and v_existing.payment_status = 'PAID'
       and v_existing.razorpay_order_id = p_payment_order_id
       and v_existing.razorpay_payment_id = p_payment_id
       and v_existing.payment_request_sha256 = p_request_sha256
       and v_existing.verification_amount_paise = p_amount_paise then
      return p_order_id;
    end if;
    raise exception 'Order reference already exists' using errcode = '23505';
  end if;
  if exists (select 1 from public.orders where razorpay_order_id = p_payment_order_id or razorpay_payment_id = p_payment_id) then
    raise exception 'Payment reference already used' using errcode = '23505';
  end if;

  begin
    v_order := p_order_json::jsonb;
  exception when others then
    raise exception 'Invalid order data' using errcode = '22023';
  end;
  insert into public.orders (
    id, customer_id, status, category, vehicle_brand, vehicle_type, vehicle_model,
    vehicle_year, ecu_manufacturer, ecu_model, reading_tool, selected_services, notes,
    contact_name, contact_phone, contact_email, payment_status, razorpay_order_id,
    razorpay_payment_id, verification_amount_paise, payment_request_sha256, paid_at
  ) values (
    p_order_id, v_customer_id, 'New', v_order->>'category', v_order->>'vehicleBrand',
    v_order->>'vehicleType', v_order->>'vehicleModel', nullif(v_order->>'vehicleYear', '')::smallint,
    nullif(v_order->>'ecuManufacturer', ''), nullif(v_order->>'ecuModel', ''),
    nullif(v_order->>'readingTool', ''), array(select jsonb_array_elements_text(v_order->'selectedServices')),
    concat_ws(E'\n\n', nullif(v_order->>'notes', ''),
      '[EFSI_PRICE_SNAPSHOT_V1]' || E'\n' || 'file_verification_paise=' || p_amount_paise::text,
      '[EFSI_PAYMENT_V1]' || E'\n' || 'payment_status=PAID' || E'\n' || 'payment_provider=razorpay' || E'\n' ||
      'razorpay_order_id=' || p_payment_order_id || E'\n' || 'razorpay_payment_id=' || p_payment_id || E'\n' ||
      'request_sha256=' || p_request_sha256 || E'\n' || 'payment_proof=' || v_expected_proof),
    v_order->>'contactName', v_order->>'contactPhone',
    nullif(v_order->>'contactEmail', ''), 'PAID', p_payment_order_id, p_payment_id,
    p_amount_paise, p_request_sha256, now()
  );

  return p_order_id;
end;
$$;

revoke all on function public.efsi_create_paid_order(uuid, text, text, bigint, text, text, text) from public, anon;
grant execute on function public.efsi_create_paid_order(uuid, text, text, bigint, text, text, text) to authenticated;

drop policy if exists "Customers register original files for own new orders" on public.order_files;
drop policy if exists "Customers register original files for own paid orders" on public.order_files;
create policy "Customers register original files for own paid orders"
  on public.order_files for insert to authenticated with check (
    owner_id = (select auth.uid()) and uploaded_by = (select auth.uid()) and kind = 'original'
    and split_part(object_path, '/', 1) = (select auth.uid())::text
    and split_part(object_path, '/', 2) = order_id::text
    and split_part(object_path, '/', 3) = 'original'
    and exists (select 1 from public.orders o
      where o.id = order_id and o.customer_id = (select auth.uid())
        and o.status = 'New' and o.payment_status = 'PAID')
  );

drop policy if exists "Customers upload originals to own new orders" on storage.objects;
drop policy if exists "Customers upload originals to own paid orders" on storage.objects;
create policy "Customers upload originals to own paid orders"
  on storage.objects for insert to authenticated with check (
    bucket_id = 'private-ecu-files'
    and split_part(name, '/', 1) = (select auth.uid())::text
    and split_part(name, '/', 3) = 'original'
    and split_part(name, '/', 4) <> ''
    and exists (select 1 from public.orders o
      where o.id::text = split_part(name, '/', 2)
        and o.customer_id = (select auth.uid()) and o.status = 'New' and o.payment_status = 'PAID')
  );

commit;
