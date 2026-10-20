-- Atomic, idempotent finalization after the server independently verifies Razorpay order/payment/signature.
create or replace function public.efsi_finalize_advertising_payment(
  p_quote_id uuid,
  p_payment_id uuid,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_amount_paise bigint,
  p_currency text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.advertising_quotes%rowtype;
  p public.advertising_payments%rowtype;
begin
  if p_currency <> 'INR' or p_amount_paise < 1
     or p_provider_order_id !~ '^order_[A-Za-z0-9]+$'
     or p_provider_payment_id !~ '^pay_[A-Za-z0-9]+$' then
    raise exception 'Invalid advertising payment reference or amount';
  end if;

  select * into q from public.advertising_quotes
    where id = p_quote_id for update;
  if not found then raise exception 'Advertising quote not found'; end if;

  select * into p from public.advertising_payments
    where id = p_payment_id and quote_id = p_quote_id for update;
  if not found then raise exception 'Advertising payment attempt not found'; end if;

  if q.amount_paise <> p_amount_paise or q.currency <> p_currency
     or p.amount_paise <> p_amount_paise or p.currency <> p_currency
     or p.provider_order_id <> p_provider_order_id then
    raise exception 'Advertising payment amount or order mismatch';
  end if;

  if q.status = 'paid' and p.status = 'verified'
     and p.provider_payment_id = p_provider_payment_id
     and p.provider_evidence_verified then
    return true;
  end if;

  if q.status not in ('accepted','payment_pending')
     or (q.expires_at <= now() and p.created_at > q.expires_at)
     or p.status not in ('created','authorized','captured')
     or p.provider_payment_id is not null and p.provider_payment_id <> p_provider_payment_id then
    raise exception 'Advertising quote/payment is not eligible for finalization';
  end if;

  update public.advertising_payments
    set status = 'verified',
        provider_payment_id = p_provider_payment_id,
        provider_evidence_verified = true,
        verified_at = now(),
        updated_at = now()
    where id = p.id;

  update public.advertising_quotes
    set status = 'paid', paid_at = now(), updated_at = now()
    where id = q.id;

  insert into public.advertising_payment_audit
    (quote_id, payment_id, event_type, details)
  values
    (q.id, p.id, 'payment_verification_succeeded',
     jsonb_build_object('provider', 'razorpay', 'amount_paise', p_amount_paise, 'currency', p_currency));

  return true;
end;
$$;

revoke all on function public.efsi_finalize_advertising_payment(uuid, uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.efsi_finalize_advertising_payment(uuid, uuid, text, text, bigint, text) to service_role;
