alter table public.advertising_inquiries
  add column if not exists admin_archived_at timestamptz;

create index if not exists advertising_inquiries_admin_archive_created_idx
  on public.advertising_inquiries(admin_archived_at, created_at desc);
