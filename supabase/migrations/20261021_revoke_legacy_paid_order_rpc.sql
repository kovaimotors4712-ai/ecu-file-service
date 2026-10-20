-- Retire the legacy Razorpay-only paid-order RPC.
-- The active provider-neutral checkout path calls efsi_finalize_paid_checkout.
-- Keep the function definition for rollback/history, but prevent API roles from invoking it.
BEGIN;

REVOKE ALL ON FUNCTION public.efsi_create_paid_order(
  uuid, text, text, bigint, text, text, text
) FROM PUBLIC, anon, authenticated;

COMMIT;
