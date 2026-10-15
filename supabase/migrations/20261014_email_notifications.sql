-- ECU File Service India transactional email delivery improvements.
-- Apply after 20261004_updates.sql. Historical orders with missing email are preserved.
BEGIN;

ALTER TABLE public.notification_outbox
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Upgrade old order/event unique keys into explicit idempotency keys before
-- allowing multiple distinct status changes for a single order.
UPDATE public.notification_outbox
SET event_key = order_id::text || ':' || event_type
WHERE event_key IS NULL;

ALTER TABLE public.notification_outbox
  ALTER COLUMN event_key SET NOT NULL;

ALTER TABLE public.notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_order_id_event_type_key;
DROP INDEX IF EXISTS public.notification_outbox_order_id_event_type_key;
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_event_key_uidx
  ON public.notification_outbox(event_key);

ALTER TABLE public.notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_event_type_check;
ALTER TABLE public.notification_outbox
  ADD CONSTRAINT notification_outbox_event_type_check
  CHECK (event_type IN ('new_order','paid_order','status_change'));

CREATE OR REPLACE FUNCTION public.enqueue_admin_order_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notification_outbox(order_id,event_type,event_key,payload)
    VALUES (new.id,'new_order',new.id::text || ':new_order','{}'::jsonb)
    ON CONFLICT (event_key) DO NOTHING;

    IF new.payment_status = 'PAID' THEN
      INSERT INTO public.notification_outbox(order_id,event_type,event_key,payload)
      VALUES (new.id,'paid_order',new.id::text || ':paid_order','{}'::jsonb)
      ON CONFLICT (event_key) DO NOTHING;
    END IF;
    RETURN new;
  END IF;

  IF new.payment_status IS DISTINCT FROM old.payment_status AND new.payment_status = 'PAID' THEN
    INSERT INTO public.notification_outbox(order_id,event_type,event_key,payload)
    VALUES (new.id,'paid_order',new.id::text || ':paid_order','{}'::jsonb)
    ON CONFLICT (event_key) DO NOTHING;
  END IF;

  IF new.status IS DISTINCT FROM old.status THEN
    INSERT INTO public.notification_outbox(order_id,event_type,event_key,payload)
    VALUES (
      new.id,
      'status_change',
      new.id::text || ':status_change:' || extensions.gen_random_uuid()::text,
      pg_catalog.jsonb_build_object('previous_status',old.status::text,'status',new.status::text)
    )
    ON CONFLICT (event_key) DO NOTHING;
  END IF;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS orders_notification_outbox ON public.orders;
CREATE TRIGGER orders_notification_outbox
  AFTER INSERT OR UPDATE OF payment_status,status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_admin_order_notifications();

-- Require valid customer email for new orders only. Existing historical rows
-- with a null/blank contact_email remain untouched and can still notify Admin.
CREATE OR REPLACE FUNCTION public.enforce_order_contact_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (new.contact_email IS NULL OR pg_catalog.btrim(new.contact_email) = '') THEN
    RAISE EXCEPTION 'Customer email is required for new orders.';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS orders_enforce_contact_email ON public.orders;
CREATE TRIGGER orders_enforce_contact_email
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_order_contact_email();

COMMIT;
