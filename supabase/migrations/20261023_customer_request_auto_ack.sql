-- Add an immutable-by-customer automatic acknowledgement to private customer requests.
BEGIN;
ALTER TABLE public.forum_customer_requests
  ADD COLUMN IF NOT EXISTS customer_auto_reply text NOT NULL DEFAULT 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, ECU SOLUTION will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.';
ALTER TABLE public.forum_customer_requests
  DROP CONSTRAINT IF EXISTS forum_customer_requests_auto_reply_check;
ALTER TABLE public.forum_customer_requests
  ADD CONSTRAINT forum_customer_requests_auto_reply_check
  CHECK (customer_auto_reply = 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, ECU SOLUTION will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.');
DROP POLICY IF EXISTS forum_customer_requests_insert_owner ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_insert_owner ON public.forum_customer_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = 'open'
    AND admin_reply = ''
    AND customer_auto_reply = 'We received your request. Please check My Account → My requests & messages for updates. After reviewing your software request, ECU SOLUTION will send the official payment link here or through the agreed contact channel. Please pay only after you receive and verify the payment link.'
  );
COMMIT;
