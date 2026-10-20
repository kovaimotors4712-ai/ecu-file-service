-- Tighten direct RPC permissions for trigger-only SECURITY DEFINER functions.
-- Existing triggers continue invoking these functions; they are not intended as public RPC endpoints.
-- Payment-finalization functions are intentionally untouched.
BEGIN;

REVOKE ALL ON FUNCTION public.create_profile_for_auth_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_order_contact_email() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_second_stage_payment_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_admin_order_notifications() FROM PUBLIC, anon, authenticated;

COMMIT;
