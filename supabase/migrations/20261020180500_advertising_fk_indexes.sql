-- Cover foreign keys used for audit attribution and administrator filtering.
create index if not exists advertising_payment_audit_actor_user_id_idx
  on public.advertising_payment_audit (actor_user_id)
  where actor_user_id is not null;
create index if not exists advertising_quotes_created_by_idx
  on public.advertising_quotes (created_by)
  where created_by is not null;
create index if not exists site_announcements_created_by_idx
  on public.site_announcements (created_by)
  where created_by is not null;
