-- Add threaded replies, private customer requests, and the admin-managed software catalogue.
-- Additive schema change; existing orders, payments, and advertising data are untouched.
BEGIN;

ALTER TABLE public.forum_chat_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid
  REFERENCES public.forum_chat_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS forum_chat_messages_reply_to_idx
  ON public.forum_chat_messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.forum_customer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_type text NOT NULL CHECK (request_type IN ('service_requirement','feature_request','suggestion','software_requirement','wiring_diagram','issue','other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 4 AND 120),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 10 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','waiting_for_customer','resolved','closed')),
  admin_reply text NOT NULL DEFAULT '' CHECK (char_length(admin_reply) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forum_customer_requests_user_created_idx
  ON public.forum_customer_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forum_customer_requests_open_created_idx
  ON public.forum_customer_requests(created_at ASC)
  WHERE status IN ('open','in_review','waiting_for_customer');
ALTER TABLE public.forum_customer_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS forum_customer_requests_read_owner_or_moderator ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_read_owner_or_moderator ON public.forum_customer_requests
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR COALESCE((auth.jwt()->'app_metadata'->>'role') IN ('admin','moderator'),false));
DROP POLICY IF EXISTS forum_customer_requests_insert_owner ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_insert_owner ON public.forum_customer_requests
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND status = 'open' AND admin_reply = '');
DROP POLICY IF EXISTS forum_customer_requests_update_moderator ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_update_moderator ON public.forum_customer_requests
  FOR UPDATE TO authenticated
  USING (COALESCE((auth.jwt()->'app_metadata'->>'role') IN ('admin','moderator'),false))
  WITH CHECK (COALESCE((auth.jwt()->'app_metadata'->>'role') IN ('admin','moderator'),false));
REVOKE ALL ON public.forum_customer_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.forum_customer_requests TO authenticated;

CREATE TABLE IF NOT EXISTS public.software_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 180),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  version text NOT NULL DEFAULT '' CHECK (char_length(version) <= 80),
  price_paise bigint NOT NULL CHECK (price_paise >= 0 AND price_paise <= 100000000000),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  image_url text,
  product_url text,
  contact_url text,
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 100000),
  is_published boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS software_products_published_order_idx
  ON public.software_products(is_published, sort_order, created_at DESC);
ALTER TABLE public.software_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.software_products FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.software_products TO service_role;

COMMIT;
