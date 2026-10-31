-- Permit distinct intentional submissions with identical request data.
-- A retry using the same client attempt ID returns the same checkout intent.
alter table public.checkout_intents add column if not exists client_attempt_id uuid;
alter table public.checkout_intents drop constraint if exists checkout_intents_storage_path_check;
alter table public.checkout_intents add constraint checkout_intents_storage_path_check
  check (storage_path ~ '^content/[a-f0-9]{64}$');
drop index if exists public.checkout_intents_active_hash_uidx;
create unique index if not exists checkout_intents_customer_attempt_uidx
  on public.checkout_intents(customer_id, client_attempt_id)
  where client_attempt_id is not null;
create index if not exists checkout_intents_customer_request_idx
  on public.checkout_intents(customer_id, request_sha256, created_at desc);

-- Allow the customer's two Airbag photos to be staged only when their exact
-- random object paths are already declared in that customer's checkout intent.
-- Keep the original BIN/HEX upload bound to checkout_intents.storage_path.
drop policy if exists "Customers upload own checkout files" on storage.objects;
create policy "Customers upload own checkout files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'private-ecu-files'
    and split_part(name, '/', 1) = 'content'
    and split_part(name, '/', 2) ~ '^[a-f0-9]{64}$'
    and exists (
      select 1 from public.checkout_intents c
      where c.customer_id = (select auth.uid())
        and c.status in ('DRAFT','FILE_STAGED','PAYMENT_PENDING')
        and c.payment_status = 'PENDING'
        and c.expires_at > now()
        and (
          c.storage_path = name
          or c.request_json -> 'modulePhoto' ->> 'storagePath' = name
          or c.request_json -> 'partNumberPhoto' ->> 'storagePath' = name
        )
    )
  );
