-- Link partner advertisements to the exact paid quote that authorizes their placement.
alter table public.site_announcements
  add column if not exists advertising_quote_id uuid references public.advertising_quotes(id) on delete restrict;
create unique index if not exists site_announcements_advertising_quote_uidx
  on public.site_announcements (advertising_quote_id)
  where advertising_quote_id is not null;

create or replace function public.enforce_paid_advertising_publication()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.advertising_quotes%rowtype;
  should_validate boolean := false;
begin
  if NEW.advertising_quote_id is not null and NEW.kind <> 'ad' then
    raise exception 'Advertising quotes can only be linked to partner advertisement content';
  end if;
  if NEW.kind = 'ad' and NEW.is_published then
    if TG_OP = 'INSERT' then
      should_validate := true;
    elsif OLD.is_published is distinct from NEW.is_published
       or OLD.kind is distinct from NEW.kind
       or OLD.advertising_quote_id is distinct from NEW.advertising_quote_id
       or OLD.starts_at is distinct from NEW.starts_at
       or OLD.ends_at is distinct from NEW.ends_at
       or OLD.placement is distinct from NEW.placement then
      should_validate := true;
    end if;
  end if;

  if should_validate then
    if NEW.advertising_quote_id is null then
      raise exception 'A verified paid advertising quote is required before publishing an advertisement';
    end if;
    select * into q from public.advertising_quotes
      where id = NEW.advertising_quote_id for share;
    if not found or q.status <> 'paid' or q.placement <> NEW.placement
       or q.starts_at <> NEW.starts_at or q.ends_at <> NEW.ends_at
       or q.ends_at <= now() then
      raise exception 'The advertising quote is not paid or does not match this publication schedule';
    end if;
    insert into public.advertising_payment_audit (quote_id, actor_user_id, event_type, details)
    values (q.id, NEW.created_by, 'ad_published',
      jsonb_build_object('announcement_id', NEW.id, 'placement', NEW.placement, 'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at));
  elsif TG_OP = 'UPDATE' and OLD.is_published and not NEW.is_published and OLD.kind = 'ad' and OLD.advertising_quote_id is not null then
    insert into public.advertising_payment_audit (quote_id, actor_user_id, event_type, details)
    values (OLD.advertising_quote_id, NEW.created_by, 'ad_unpublished',
      jsonb_build_object('announcement_id', OLD.id, 'unpublished_at', now()));
  end if;
  return NEW;
end;
$$;
drop trigger if exists site_announcements_paid_ad_guard on public.site_announcements;
create trigger site_announcements_paid_ad_guard
before insert or update on public.site_announcements
for each row execute function public.enforce_paid_advertising_publication();
revoke all on function public.enforce_paid_advertising_publication() from public, anon, authenticated;
