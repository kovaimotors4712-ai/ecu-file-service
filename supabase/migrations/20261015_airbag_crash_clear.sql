-- ECU File Service India Airbag Crash Clear flow.
-- Extends the existing payment finalizer and private bucket without changing payment verification.
-- Apply after 20261014_email_notifications.sql. Do not expose storage objects publicly.
BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS module_details text;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_module_details_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_module_details_check
  CHECK (module_details IS NULL OR pg_catalog.length(module_details) <= 1200);

-- Preserve all old service values for history while adding the Airbag-only service.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_selected_services_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_selected_services_check CHECK (
  pg_catalog.cardinality(selected_services) > 0 AND selected_services <@ ARRAY[
    'DTC OFF','DPF OFF','AdBlue / SCR OFF','EGR OFF','O2 Remove','EVAP OFF','Decat','IMMO OFF','Speed Limit','Custom Request','Crash Clear'
  ]::text[]
);

CREATE TABLE IF NOT EXISTS public.order_attachments (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('module_photo','part_number_photo')),
  bucket_id text NOT NULL DEFAULT 'private-ecu-files' CHECK (bucket_id = 'private-ecu-files'),
  object_path text NOT NULL CHECK (object_path ~ '^content/[a-f0-9]{64}$'),
  original_name text NOT NULL CHECK (pg_catalog.length(original_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_attachments_order_owner_fk FOREIGN KEY (order_id, owner_id)
    REFERENCES public.orders(id, customer_id) ON DELETE CASCADE,
  CONSTRAINT order_attachments_one_kind_per_order UNIQUE (order_id, kind)
);
CREATE INDEX IF NOT EXISTS order_attachments_owner_created_idx
  ON public.order_attachments(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_attachments_object_path_idx
  ON public.order_attachments(object_path);

ALTER TABLE public.order_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_attachments FROM anon, public;
GRANT SELECT ON public.order_attachments TO authenticated;
GRANT ALL ON public.order_attachments TO service_role;
DROP POLICY IF EXISTS "Customers read own airbag attachments; admins read all" ON public.order_attachments;
CREATE POLICY "Customers read own airbag attachments; admins read all"
  ON public.order_attachments FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()) OR (SELECT public.is_admin()));

-- Let a customer upload/read only paths present in their own unexpired checkout JSON.
-- Existing original-file policy and customer-owned attachments remain private.
DROP POLICY IF EXISTS "Customers upload own checkout files" ON storage.objects;
CREATE POLICY "Customers upload own checkout files"
  ON storage.objects FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'private-ecu-files'
    AND split_part(name,'/',1) = 'content'
    AND split_part(name,'/',2) ~ '^[a-f0-9]{64}$'
    AND EXISTS (
      SELECT 1 FROM public.checkout_intents c
      WHERE c.customer_id = (SELECT auth.uid())
        AND c.status IN ('DRAFT','FILE_STAGED','PAYMENT_PENDING')
        AND c.payment_status = 'PENDING' AND c.expires_at > now()
        AND (c.storage_path = name
          OR c.request_json -> 'modulePhoto' ->> 'storagePath' = name
          OR c.request_json -> 'partNumberPhoto' ->> 'storagePath' = name)
    )
  );

DROP POLICY IF EXISTS "Customers read own checkout and order files" ON storage.objects;
CREATE POLICY "Customers read own checkout and order files"
  ON storage.objects FOR SELECT TO authenticated USING (
    bucket_id = 'private-ecu-files' AND (
      EXISTS (
        SELECT 1 FROM public.checkout_intents c
        WHERE c.customer_id = (SELECT auth.uid())
          AND c.status IN ('DRAFT','FILE_STAGED','PAYMENT_PENDING','PAID','EXPIRED','CANCELLED')
          AND (c.storage_path = name
            OR c.request_json -> 'modulePhoto' ->> 'storagePath' = name
            OR c.request_json -> 'partNumberPhoto' ->> 'storagePath' = name)
      )
      OR EXISTS (SELECT 1 FROM public.order_files f WHERE f.owner_id = (SELECT auth.uid()) AND f.bucket_id = 'private-ecu-files' AND f.object_path = name)
      OR EXISTS (SELECT 1 FROM public.order_attachments a WHERE a.owner_id = (SELECT auth.uid()) AND a.bucket_id = 'private-ecu-files' AND a.object_path = name)
      OR (SELECT public.is_admin())
    )
  );

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

  -- Public ordering no longer accepts Dashboard; historical Dashboard rows stay untouched.
  if v_category not in ('ECU','AIRBAG') then
    raise exception 'New orders must be ECU or AIRBAG' using errcode='22023';
  end if;
  if v_category = 'AIRBAG' then
    if nullif(pg_catalog.btrim(v_request ->> 'moduleDetails'),'') is null
       or pg_catalog.length(v_request ->> 'moduleDetails') > 1200
       or v_vehicle_year is null
       or pg_catalog.jsonb_typeof(v_request -> 'modulePhoto') <> 'object'
       or pg_catalog.jsonb_typeof(v_request -> 'partNumberPhoto') <> 'object'
       or v_request ->> 'selectedServices' is null
       or v_request -> 'selectedServices' <> '["Crash Clear"]'::jsonb then
      raise exception 'Airbag Crash Clear details are incomplete' using errcode='22023';
    end if;
    if (v_request -> 'modulePhoto' ->> 'mime') not in ('image/jpeg','image/png','image/webp')
       or (v_request -> 'partNumberPhoto' ->> 'mime') not in ('image/jpeg','image/png','image/webp')
       or coalesce((v_request -> 'modulePhoto' ->> 'size')::bigint,0) not between 1 and 10485760
       or coalesce((v_request -> 'partNumberPhoto' ->> 'size')::bigint,0) not between 1 and 10485760
       or (v_request -> 'modulePhoto' ->> 'sha256') !~ '^[a-f0-9]{64}$'
       or (v_request -> 'partNumberPhoto' ->> 'sha256') !~ '^[a-f0-9]{64}$'
       or (v_request -> 'modulePhoto' ->> 'storagePath') <> ('content/' || (v_request -> 'modulePhoto' ->> 'sha256'))
       or (v_request -> 'partNumberPhoto' ->> 'storagePath') <> ('content/' || (v_request -> 'partNumberPhoto' ->> 'sha256')) then
      raise exception 'Airbag photo metadata is invalid' using errcode='22023';
    end if;
    if not exists (select 1 from storage.objects where bucket_id='private-ecu-files' and name=v_request -> 'modulePhoto' ->> 'storagePath')
       or not exists (select 1 from storage.objects where bucket_id='private-ecu-files' and name=v_request -> 'partNumberPhoto' ->> 'storagePath') then
      raise exception 'Airbag photos are not staged in private storage' using errcode='P0002';
    end if;
  end if;

  insert into public.orders (
    id, customer_id, status, category, vehicle_brand, vehicle_type, vehicle_model,
    vehicle_year, ecu_manufacturer, ecu_model, reading_tool, selected_services,
    notes, module_details, contact_name, contact_phone, contact_email,
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
    case when v_category='AIRBAG' then nullif(v_request ->> 'moduleDetails','') else null end,
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

  if v_category = 'AIRBAG' then
    insert into public.order_attachments (
      order_id, owner_id, kind, bucket_id, object_path, original_name, mime_type, size_bytes, uploaded_by
    ) values (
      v_order_id, v_customer_id, 'module_photo', 'private-ecu-files', v_request -> 'modulePhoto' ->> 'storagePath',
      v_request -> 'modulePhoto' ->> 'name', v_request -> 'modulePhoto' ->> 'mime',
      (v_request -> 'modulePhoto' ->> 'size')::bigint, v_customer_id
    );
    insert into public.order_attachments (
      order_id, owner_id, kind, bucket_id, object_path, original_name, mime_type, size_bytes, uploaded_by
    ) values (
      v_order_id, v_customer_id, 'part_number_photo', 'private-ecu-files', v_request -> 'partNumberPhoto' ->> 'storagePath',
      v_request -> 'partNumberPhoto' ->> 'name', v_request -> 'partNumberPhoto' ->> 'mime',
      (v_request -> 'partNumberPhoto' ->> 'size')::bigint, v_customer_id
    );
  end if;

  update public.checkout_intents
  set status='PAID', payment_status='PAID', order_id=v_order_id, payment_provider=p_payment_provider,
      provider_order_id=p_provider_order_id, provider_payment_id=p_provider_payment_id,
      paid_at=coalesce(p_paid_at, now()), updated_at=now()
  where id=v_intent.id and customer_id=v_customer_id;

  return v_order_id;
end;
$$;


REVOKE ALL ON FUNCTION public.efsi_finalize_paid_checkout(uuid,text,text,text,bigint,text,timestamptz,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.efsi_finalize_paid_checkout(uuid,text,text,text,bigint,text,timestamptz,text) TO authenticated;

COMMIT;
