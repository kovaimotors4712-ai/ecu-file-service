-- Fix paid checkout finalization: new orders inherit second_stage_status='pending'
-- from the column default. That default must not be treated as a second-stage edit.
-- Existing protections for non-default second-stage values remain in force.
BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_second_stage_payment_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Normal first-stage checkout creates a New order with no second-stage payment.
  -- The column default 'pending' is inert when no amount/link/paid timestamp exists.
  IF TG_OP = 'INSERT'
     AND NEW.second_stage_amount IS NULL
     AND NEW.second_stage_payment_link IS NULL
     AND (NEW.second_stage_status IS NULL OR NEW.second_stage_status = 'pending')
     AND NEW.second_stage_paid_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Updates unrelated to second-stage fields are always allowed by this guard.
  IF TG_OP = 'UPDATE'
     AND NEW.second_stage_amount IS NOT DISTINCT FROM OLD.second_stage_amount
     AND NEW.second_stage_payment_link IS NOT DISTINCT FROM OLD.second_stage_payment_link
     AND NEW.second_stage_status IS NOT DISTINCT FROM OLD.second_stage_status
     AND NEW.second_stage_paid_at IS NOT DISTINCT FROM OLD.second_stage_paid_at THEN
    RETURN NEW;
  END IF;

  -- Preserve the existing admin/service-role restrictions and Possible-state rule.
  IF current_setting('role', true) = 'service_role'
     OR ((EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin')) AND public.is_admin()) THEN
    IF NEW.status <> 'Possible' THEN
      RAISE EXCEPTION 'Second-stage payment fields can only be modified while the order status is Possible, and cannot be changed in an update that moves the order out of Possible.' USING errcode = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Unauthorized modification of second-stage payment fields.' USING errcode = '42501';
END;
$$;

DROP TRIGGER IF EXISTS orders_second_stage_state_trigger ON public.orders;
CREATE TRIGGER orders_second_stage_state_trigger
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_second_stage_payment_state();

COMMIT;