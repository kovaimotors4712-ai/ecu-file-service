-- Align the customer-request insert policy with the current client confirmation text.
-- Customers may create only their own open requests; admin replies remain server/admin-managed.
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
);
COMMIT;
