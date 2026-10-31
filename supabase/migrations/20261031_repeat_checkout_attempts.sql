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
