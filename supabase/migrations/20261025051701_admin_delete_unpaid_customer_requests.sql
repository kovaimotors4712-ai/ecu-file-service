-- Secure administrator deletion for private customer requests.
-- Only requests with no payment or delivery activity may be permanently removed.
BEGIN;

CREATE OR REPLACE FUNCTION public.efsi_admin_delete_customer_request(
  p_request_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  r public.forum_customer_requests%rowtype;
BEGIN
  IF COALESCE(((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Administrator role required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO r
    FROM public.forum_customer_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer request not found.' USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(r.software_status, '') IN ('awaiting_payment', 'paid', 'delivered')
     OR r.software_payment_link_id IS NOT NULL
     OR r.software_payment_link IS NOT NULL
     OR r.software_delivery_path IS NOT NULL
     OR r.software_delivery_url IS NOT NULL
     OR r.software_delivery_name IS NOT NULL THEN
    RAISE EXCEPTION 'This request has payment or delivery history. Archive or close it instead; financial and delivery records must be retained.'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.forum_customer_requests
   WHERE id = p_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.efsi_admin_delete_customer_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.efsi_admin_delete_customer_request(uuid) TO authenticated, service_role;

COMMIT;
