-- Disable the obsolete direct paid-order RPC after moving checkout finalization to
-- efsi_finalize_paid_checkout. The legacy function is not referenced by application code.
-- Keep the active customer-token payment finalizer unchanged.
BEGIN;

REVOKE ALL ON FUNCTION public.efsi_create_paid_order(uuid, text, text, bigint, text, text, text)
FROM PUBLIC, anon, authenticated;

COMMIT;
