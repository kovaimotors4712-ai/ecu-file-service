create table if not exists public.site_announcements (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('announcement','offer','ad')),
  title text not null check (char_length(title) between 1 and 180),
  body text not null default '' check (char_length(body) <= 4000),
  image_url text,
  cta_label text,
  cta_url text,
  placement text not null default 'banner' check (placement in ('banner','homepage','sidebar')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  is_published boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_announcements_valid_window check (ends_at is null or ends_at > starts_at),
  constraint site_announcements_https_links check ((image_url is null or image_url ~ '^https://') and (cta_url is null or cta_url ~ '^https://'))
);
create index if not exists site_announcements_public_window_idx on public.site_announcements (is_published, starts_at, ends_at, kind);
alter table public.site_announcements enable row level security;
create table if not exists public.advertising_inquiries (
  id uuid primary key default gen_random_uuid(),
  business_name text not null check (char_length(business_name) between 1 and 160),
  contact_name text not null check (char_length(contact_name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 254),
  phone text not null check (char_length(phone) between 5 and 40),
  website text,
  ad_type text not null check (ad_type in ('banner','offer','sponsorship','other')),
  message text not null check (char_length(message) between 10 and 2000),
  status text not null default 'new' check (status in ('new','contacted','approved','declined','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint advertising_inquiries_https_website check (website is null or website ~ '^https://')
);
create index if not exists advertising_inquiries_status_created_idx on public.advertising_inquiries (status, created_at desc);
alter table public.advertising_inquiries enable row level security;
