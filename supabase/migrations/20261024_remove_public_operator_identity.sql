-- Remove shop/operator identity from customer-visible automatic request replies.
-- Keep the default, CHECK constraint, trigger function, and existing generated values identical.
-- This migration updates only the fixed auto-reply text; it does not change request ownership or access policies.

BEGIN;

ALTER TABLE public.forum_customer_requests
  DROP CONSTRAINT IF EXISTS forum_customer_requests_auto_reply_check;

UPDATE public.forum_customer_requests
   SET customer_auto_reply = 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, our team will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.';

ALTER TABLE public.forum_customer_requests
  ALTER COLUMN customer_auto_reply
  SET DEFAULT 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, our team will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.';

ALTER TABLE public.forum_customer_requests
  ADD CONSTRAINT forum_customer_requests_auto_reply_check
  CHECK (customer_auto_reply = 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, our team will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.');

CREATE OR REPLACE FUNCTION public.forum_customer_requests_set_auto_reply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  NEW.customer_auto_reply := 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, our team will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.';
  RETURN NEW;
END;
$function$;

COMMIT;
