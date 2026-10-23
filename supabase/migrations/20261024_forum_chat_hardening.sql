-- Harden the live workshop chat and reduce per-row policy overhead.
-- Additive only; does not change existing messages, orders, or payment records.
BEGIN;

-- Supports author lookups and the per-user chat rate limiter.
CREATE INDEX IF NOT EXISTS forum_chat_messages_author_created_idx
  ON public.forum_chat_messages (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS software_products_created_by_idx
  ON public.software_products (created_by)
  WHERE created_by IS NOT NULL;

-- Limit chat flooding at the database boundary, even if a client bypasses the UI.
CREATE OR REPLACE FUNCTION public.forum_chat_enforce_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  recent_count integer := 0;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.author_id::text, 0)
  );

  SELECT count(*) INTO recent_count
  FROM public.forum_chat_messages AS m
  WHERE m.author_id = NEW.author_id
    AND m.created_at > pg_catalog.now() - interval '1 minute';

  IF recent_count >= 10 THEN
    RAISE EXCEPTION 'Chat rate limit reached. Please wait before sending another message.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.forum_chat_enforce_rate_limit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS forum_chat_messages_rate_limit ON public.forum_chat_messages;
CREATE TRIGGER forum_chat_messages_rate_limit
BEFORE INSERT ON public.forum_chat_messages
FOR EACH ROW EXECUTE FUNCTION public.forum_chat_enforce_rate_limit();

-- Avoid re-evaluating auth helpers for every row in policy checks.
DROP POLICY IF EXISTS forum_chat_insert_owner ON public.forum_chat_messages;
CREATE POLICY forum_chat_insert_owner
ON public.forum_chat_messages
FOR INSERT TO authenticated
WITH CHECK (
  author_id = (SELECT auth.uid())
  AND char_length(btrim(body)) BETWEEN 1 AND 1200
);

DROP POLICY IF EXISTS forum_chat_delete_owner_or_moderator ON public.forum_chat_messages;
CREATE POLICY forum_chat_delete_owner_or_moderator
ON public.forum_chat_messages
FOR DELETE TO authenticated
USING (
  author_id = (SELECT auth.uid())
  OR COALESCE(
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin', 'moderator'),
    false
  )
);

DROP POLICY IF EXISTS forum_customer_requests_read_owner_or_moderator ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_read_owner_or_moderator
ON public.forum_customer_requests
FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR COALESCE(
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin', 'moderator'),
    false
  )
);

DROP POLICY IF EXISTS forum_customer_requests_update_moderator ON public.forum_customer_requests;
CREATE POLICY forum_customer_requests_update_moderator
ON public.forum_customer_requests
FOR UPDATE TO authenticated
USING (
  COALESCE(
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin', 'moderator'),
    false
  )
)
WITH CHECK (
  COALESCE(
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin', 'moderator'),
    false
  )
);

-- Keep updated_at accurate for moderator replies/status changes.
DROP TRIGGER IF EXISTS forum_customer_requests_touch_updated_at ON public.forum_customer_requests;
CREATE TRIGGER forum_customer_requests_touch_updated_at
BEFORE UPDATE ON public.forum_customer_requests
FOR EACH ROW EXECUTE FUNCTION public.forum_touch_updated_at();

COMMIT;
