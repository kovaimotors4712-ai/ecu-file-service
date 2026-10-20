-- Advertising quotes and payments are isolated from ECU customer orders/checkouts.
-- All reads and writes go through the trusted server using the service_role key.
create table if not exists public.advertising_quotes (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.advertising_inquiries(id) on delete restrict,
  quote_version integer not null check (quote_version > 0),
  status text not null default 'draft'
    check (status in ('draft','issued','accepted','payment_pending','paid','declined','expired','cancelled','payment_failed')),
  amount_paise bigint not null check (amount_paise between 1 and 100000000000),
  currency text not null default 'INR' check (currency = 'INR'),
  placement text not null check (placement in ('banner','homepage','sidebar')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expires_at timestamptz not null,
  terms_snapshot text not null check (char_length(terms_snapshot) between 1 and 8000),
  creative_requirements text not null default '' check (char_length(creative_requirements) <= 4000),
  acceptance_token_hash text unique check (acceptance_token_hash is null or acceptance_token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz,
  accepted_at timestamptz,
  paid_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advertising_quotes_valid_window check (ends_at > starts_at),
  constraint advertising_quotes_expiry check (expires_at > created_at),
  constraint advertising_quotes_issued_state check (status not in ('issued','accepted','payment_pending','paid') or (issued_at is not null and acceptance_token_hash is not null)),
  constraint advertising_quotes_accepted_state check (status not in ('accepted','payment_pending','paid') or accepted_at is not null),
  constraint advertising_quotes_paid_state check (status <> 'paid' or paid_at is not null)
);
create unique index if not exists advertising_quotes_inquiry_version_uidx
  on public.advertising_quotes (inquiry_id, quote_version);
create index if not exists advertising_quotes_status_expiry_idx
  on public.advertising_quotes (status, expires_at);
create index if not exists advertising_quotes_inquiry_created_idx
  on public.advertising_quotes (inquiry_id, created_at desc);
alter table public.advertising_quotes enable row level security;

create table if not exists public.advertising_payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.advertising_quotes(id) on delete restrict,
  provider text not null default 'razorpay' check (provider = 'razorpay'),
  status text not null default 'created'
    check (status in ('created','authorized','captured','verified','failed','cancelled')),
  amount_paise bigint not null check (amount_paise between 1 and 100000000000),
  currency text not null default 'INR' check (currency = 'INR'),
  provider_order_id text unique check (provider_order_id is null or provider_order_id ~ '^order_[A-Za-z0-9]+$'),
  provider_payment_id text unique check (provider_payment_id is null or provider_payment_id ~ '^pay_[A-Za-z0-9]+$'),
  idempotency_key text not null unique check (char_length(idempotency_key) between 16 and 200),
  provider_signature_verified boolean not null default false,
  verified_at timestamptz,
  failure_code text,
  failure_message text check (failure_message is null or char_length(failure_message) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advertising_payments_verified_state check (status <> 'verified' or (provider_signature_verified and provider_order_id is not null and provider_payment_id is not null and verified_at is not null))
);
create index if not exists advertising_payments_quote_created_idx
  on public.advertising_payments (quote_id, created_at desc);
create index if not exists advertising_payments_status_created_idx
  on public.advertising_payments (status, created_at desc);
alter table public.advertising_payments enable row level security;

-- Append-only audit trail for quote/payment lifecycle events.
create table if not exists public.advertising_payment_audit (
  id bigint generated always as identity primary key,
  quote_id uuid references public.advertising_quotes(id) on delete restrict,
  payment_id uuid references public.advertising_payments(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'quote_created','quote_issued','quote_accepted','quote_declined','quote_expired',
    'payment_order_created','payment_verification_succeeded','payment_verification_failed',
    'creative_approved','ad_published','ad_unpublished'
  )),
  details jsonb not null default '{}'::jsonb check (pg_column_size(details) <= 16384),
  created_at timestamptz not null default now(),
  constraint advertising_payment_audit_has_subject check (quote_id is not null or payment_id is not null)
);
create index if not exists advertising_payment_audit_quote_created_idx
  on public.advertising_payment_audit (quote_id, created_at desc);
create index if not exists advertising_payment_audit_payment_created_idx
  on public.advertising_payment_audit (payment_id, created_at desc);
alter table public.advertising_payment_audit enable row level security;
