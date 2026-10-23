-- Prevent customer-created software requests from impersonating quoted, paid or delivered orders.
-- Only the trusted administrator workflow may assign pricing, payment and delivery data.
BEGIN;

DROP POLICY IF EXISTS forum_customer_requests_insert_owner ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_insert_owner
ON public.forum_customer_requests
FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND status = 'open'
  AND COALESCE(admin_reply, '') = ''
  AND request_type IN ('software_requirement','wiring_diagram','suggestion','service_requirement','feature_request','issue','other')
  AND quoted_price_paise IS NULL
  AND software_payment_link IS NULL
  AND software_delivery_url IS NULL
  AND customer_hidden_at IS NULL
  AND admin_archived_at IS NULL
  AND (
    (software_product_id IS NULL AND software_status = 'not_applicable')
    OR
    (request_type = 'software_requirement' AND software_product_id IS NOT NULL AND software_status = 'requested')
  )
);

COMMIT;
