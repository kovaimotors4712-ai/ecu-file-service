-- Reversible archive/hide controls. Preserve payment/order evidence and private files.
BEGIN;
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_archived_at timestamptz;
ALTER TABLE public.forum_customer_requests
  ADD COLUMN IF NOT EXISTS customer_hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_archived_at timestamptz;
CREATE INDEX IF NOT EXISTS orders_visible_customer_history_idx
  ON public.orders(customer_id, created_at DESC)
  WHERE customer_hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_admin_active_archive_idx
  ON public.orders(created_at DESC)
  WHERE admin_archived_at IS NULL;
CREATE INDEX IF NOT EXISTS forum_customer_requests_visible_owner_idx
  ON public.forum_customer_requests(user_id, created_at DESC)
  WHERE customer_hidden_at IS NULL;
CREATE INDEX IF NOT EXISTS forum_customer_requests_admin_active_idx
  ON public.forum_customer_requests(created_at DESC)
  WHERE admin_archived_at IS NULL;
COMMENT ON COLUMN public.orders.customer_hidden_at IS 'Customer-facing history hide marker; never deletes payment/order evidence or files.';
COMMENT ON COLUMN public.orders.admin_archived_at IS 'Admin archive marker; reversible and does not delete order/payment evidence or files.';
COMMENT ON COLUMN public.forum_customer_requests.customer_hidden_at IS 'Customer-facing request history hide marker; preserves admin audit trail.';
COMMENT ON COLUMN public.forum_customer_requests.admin_archived_at IS 'Admin archive marker; reversible and preserves request history.';
COMMIT;
