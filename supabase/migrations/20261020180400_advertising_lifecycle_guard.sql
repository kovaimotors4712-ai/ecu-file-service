-- Defense in depth: lifecycle transitions and quote/payment snapshots are immutable in the database.
create or replace function public.enforce_advertising_quote_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' then
    if OLD.status <> 'draft' and (
      NEW.inquiry_id is distinct from OLD.inquiry_id
      or NEW.quote_version is distinct from OLD.quote_version
      or NEW.amount_paise is distinct from OLD.amount_paise
      or NEW.currency is distinct from OLD.currency
      or NEW.placement is distinct from OLD.placement
      or NEW.starts_at is distinct from OLD.starts_at
      or NEW.ends_at is distinct from OLD.ends_at
      or NEW.expires_at is distinct from OLD.expires_at
      or NEW.terms_snapshot is distinct from OLD.terms_snapshot
      or NEW.creative_requirements is distinct from OLD.creative_requirements
    ) then
      raise exception 'Issued advertising quote snapshots are immutable; create a new quote version';
    end if;

    if NEW.status is distinct from OLD.status and not (
      (OLD.status = 'draft' and NEW.status in ('issued','declined','cancelled'))
      or (OLD.status = 'issued' and NEW.status in ('accepted','declined','expired','cancelled'))
      or (OLD.status = 'issued' and NEW.status = 'draft' and NEW.acceptance_token_hash is null and NEW.issued_at is null and not exists (select 1 from public.advertising_payments p where p.quote_id = OLD.id))
      or (OLD.status = 'accepted' and NEW.status in ('payment_pending','paid','payment_failed','expired','cancelled'))
      or (OLD.status = 'payment_pending' and NEW.status in ('paid','payment_failed','expired','cancelled'))
      or (OLD.status = 'payment_failed' and NEW.status in ('accepted','expired','cancelled'))
    ) then
      raise exception 'Invalid advertising quote status transition';
    end if;
  end if;

  if NEW.status = 'paid' and not exists (
    select 1 from public.advertising_payments p
    where p.quote_id = NEW.id and p.status = 'verified'
      and p.provider_evidence_verified = true
      and p.amount_paise = NEW.amount_paise and p.currency = NEW.currency
      and p.provider_order_id is not null and p.provider_payment_id is not null
      and p.verified_at is not null
  ) then
    raise exception 'A verified matching advertising payment is required before marking a quote paid';
  end if;
  return NEW;
end;
$$;
drop trigger if exists advertising_quotes_lifecycle_guard on public.advertising_quotes;
create trigger advertising_quotes_lifecycle_guard
before insert or update on public.advertising_quotes
for each row execute function public.enforce_advertising_quote_lifecycle();
revoke all on function public.enforce_advertising_quote_lifecycle() from public, anon, authenticated;

create or replace function public.enforce_advertising_payment_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW.quote_id is distinct from OLD.quote_id
       or NEW.amount_paise is distinct from OLD.amount_paise
       or NEW.currency is distinct from OLD.currency
       or NEW.idempotency_key is distinct from OLD.idempotency_key then
      raise exception 'Advertising payment quote and amount snapshots are immutable';
    end if;
    if OLD.provider_order_id is not null and NEW.provider_order_id is distinct from OLD.provider_order_id then
      raise exception 'Advertising payment provider order reference is immutable';
    end if;
    if NEW.provider_payment_id is distinct from OLD.provider_payment_id and NEW.status <> 'verified' then
      raise exception 'Payment reference can only be attached during verified finalization';
    end if;
    if NEW.provider_evidence_verified and NEW.status <> 'verified' then
      raise exception 'Only verified payments may set the verification flag';
    end if;
    if NEW.status is distinct from OLD.status and not (
      (OLD.status = 'creating' and NEW.status in ('created','failed','cancelled'))
      or (OLD.status = 'created' and NEW.status in ('authorized','captured','verified','failed','cancelled'))
      or (OLD.status = 'authorized' and NEW.status in ('captured','verified','failed','cancelled'))
      or (OLD.status = 'captured' and NEW.status in ('verified','failed','cancelled'))
    ) then
      raise exception 'Invalid advertising payment status transition';
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists advertising_payments_lifecycle_guard on public.advertising_payments;
create trigger advertising_payments_lifecycle_guard
before update on public.advertising_payments
for each row execute function public.enforce_advertising_payment_lifecycle();
revoke all on function public.enforce_advertising_payment_lifecycle() from public, anon, authenticated;
