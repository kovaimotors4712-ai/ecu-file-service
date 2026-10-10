-- Migration: supabase/migrations/20261010_second_stage_payment.sql
-- Description: Adds second-stage payment link fields and constraints to public.orders,
-- and ensures RLS policies allow admins to update second-stage fields and customers to view them.

BEGIN;

-- 1. Add second-stage payment columns to public.orders
alter table public.orders
  add column if not exists second_stage_amount numeric check (second_stage_amount is null or second_stage_amount > 0),
  add column if not exists second_stage_payment_link text,
  add column if not exists second_stage_status text check (second_stage_status is null or second_stage_status in ('pending', 'paid')),
  add column if not exists second_stage_paid_at timestamptz;

-- Set default for second_stage_status if desired
alter table public.orders
  alter column second_stage_status set default 'pending';

-- 2. Add consistency check constraint requiring strictly positive amount when paid
alter table public.orders drop constraint if exists orders_second_stage_consistency_check;
alter table public.orders add constraint orders_second_stage_consistency_check
  check (
    (second_stage_status = 'paid'
      and second_stage_amount is not null
      and second_stage_amount > 0
      and second_stage_payment_link is not null
      and second_stage_paid_at is not null)
    or
    (second_stage_status is null or second_stage_status <> 'paid')
  );

-- 3. State enforcement trigger: second-stage fields can only be modified when status is 'Possible',
-- and updating status out of 'Possible' cannot be done in the same update where payment fields are changed.
create or replace function public.enforce_second_stage_payment_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Allow initial checkout flow or updates where second-stage fields are not touched
  if (new.second_stage_amount is not distinct from old.second_stage_amount) and
     (new.second_stage_payment_link is not distinct from old.second_stage_payment_link) and
     (new.second_stage_status is not distinct from old.second_stage_status) and
     (new.second_stage_paid_at is not distinct from old.second_stage_paid_at) then
    return new;
  end if;

  -- Allow service role and admins
  if current_setting('role', true) = 'service_role' or (exists (select 1 from pg_proc where proname = 'is_admin') and public.is_admin()) then
    -- Enforce that the resulting order status must be 'Possible' when modifying second-stage fields
    if new.status <> 'Possible' then
      raise exception 'Second-stage payment fields can only be modified while the order status is Possible, and cannot be changed in an update that moves the order out of Possible.' using errcode = '23514';
    end if;
    return new;
  end if;

  -- Block any customer or non-admin write attempts to second-stage fields
  raise exception 'Unauthorized modification of second-stage payment fields.' using errcode = '42501';
end;
$$;

drop trigger if exists orders_second_stage_state_trigger on public.orders;
create trigger orders_second_stage_state_trigger
  before insert or update on public.orders
  for each row execute function public.enforce_second_stage_payment_state();

grant select, update on public.orders to authenticated;
grant all on public.orders to service_role;

COMMIT;
