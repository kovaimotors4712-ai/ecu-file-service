-- Structured content for a fixed set of low-risk public information pages.
-- This migration is intentionally not applied to any live database.
create table if not exists public.site_page_content (
  page_key text primary key check (page_key in (
    'about',
    'guides',
    'vehicle_wiring',
    'international_support',
    'fault_code_diagnosis',
    'ecu_identification',
    'diagnostic_help'
  )),
  page_title text not null default '' check (char_length(page_title) <= 120),
  meta_description text not null default '' check (char_length(meta_description) <= 300),
  blocks jsonb not null default '[]'::jsonb check (
    jsonb_typeof(blocks) = 'array' and jsonb_array_length(blocks) <= 30
  ),
  status text not null default 'draft' check (status in ('draft','published','hidden')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.site_page_content enable row level security;
revoke all on table public.site_page_content from anon, authenticated;
grant select, insert, update on table public.site_page_content to service_role;

comment on table public.site_page_content is
  'Admin-managed structured supplemental content for an explicit allowlist of public information pages. No arbitrary HTML or scripts are stored.';
