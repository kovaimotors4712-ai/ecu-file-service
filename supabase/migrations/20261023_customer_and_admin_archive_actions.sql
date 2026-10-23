-- Reversible customer hide and staff archive controls for orders and private requests.
-- These functions update only visibility markers; they never delete orders, payments, requests, or files.
BEGIN;

CREATE INDEX IF NOT EXISTS forum_customer_requests_software_product_id_idx
  ON public.forum_customer_requests (software_product_id)
  WHERE software_product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.forum_hide_customer_request(
  p_request_id uuid,
  p_hidden boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.forum_customer_requests
     SET customer_hidden_at = CASE WHEN COALESCE(p_hidden, true) THEN pg_catalog.now() ELSE NULL END
   WHERE id = p_request_id
     AND user_id = auth.uid();

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.efsi_customer_hide_order(
  p_order_id uuid,
  p_hidden boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.orders
     SET customer_hidden_at = CASE WHEN COALESCE(p_hidden, true) THEN pg_catalog.now() ELSE NULL END
   WHERE id = p_order_id
     AND customer_id = auth.uid();

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.efsi_admin_archive_customer_request(
  p_request_id uuid,
  p_archived boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF COALESCE(((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Administrator role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.forum_customer_requests
     SET admin_archived_at = CASE WHEN COALESCE(p_archived, true) THEN pg_catalog.now() ELSE NULL END
   WHERE id = p_request_id;

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.efsi_admin_archive_order(
  p_order_id uuid,
  p_archived boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF COALESCE(((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Administrator role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.orders
     SET admin_archived_at = CASE WHEN COALESCE(p_archived, true) THEN pg_catalog.now() ELSE NULL END
   WHERE id = p_order_id;

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.forum_hide_customer_request(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.efsi_customer_hide_order(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.efsi_admin_archive_customer_request(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.efsi_admin_archive_order(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forum_hide_customer_request(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.efsi_customer_hide_order(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.efsi_admin_archive_customer_request(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.efsi_admin_archive_order(uuid, boolean) TO authenticated, service_role;

COMMIT;
