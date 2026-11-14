-- Per-post editorial display names for Admin-created Forum question/answer pairs.
-- These are pseudonyms on a single authenticated admin-authored record, not member accounts.
BEGIN;

ALTER TABLE public.forum_topics
  ADD COLUMN IF NOT EXISTS author_display_name text
    CHECK (author_display_name IS NULL OR (char_length(btrim(author_display_name)) BETWEEN 2 AND 32 AND author_display_name !~ '[[:cntrl:]]')),
  ADD COLUMN IF NOT EXISTS author_label text
    CHECK (author_label IS NULL OR (char_length(btrim(author_label)) BETWEEN 2 AND 80 AND author_label !~ '[[:cntrl:]]'));

ALTER TABLE public.forum_replies
  ADD COLUMN IF NOT EXISTS author_display_name text
    CHECK (author_display_name IS NULL OR (char_length(btrim(author_display_name)) BETWEEN 2 AND 32 AND author_display_name !~ '[[:cntrl:]]')),
  ADD COLUMN IF NOT EXISTS author_label text
    CHECK (author_label IS NULL OR (char_length(btrim(author_label)) BETWEEN 2 AND 80 AND author_label !~ '[[:cntrl:]]'));

COMMENT ON COLUMN public.forum_topics.author_display_name IS 'Optional per-post editorial pseudonym; never represents a separate member account.';
COMMENT ON COLUMN public.forum_topics.author_label IS 'Public provenance label for per-post editorial content.';
COMMENT ON COLUMN public.forum_replies.author_display_name IS 'Optional per-reply editorial pseudonym; never represents a separate member account.';
COMMENT ON COLUMN public.forum_replies.author_label IS 'Public provenance label for per-reply editorial content.';


-- Only trusted administrators may attach editorial pseudonyms. The public
-- provenance label is fixed so clients cannot disguise editorial content.
CREATE OR REPLACE FUNCTION public.forum_guard_editorial_author_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $
BEGIN
  IF NEW.author_display_name IS NOT NULL OR NEW.author_label IS NOT NULL THEN
    IF COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
      RAISE EXCEPTION 'Only administrators may create editorial forum entries'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.author_label IS DISTINCT FROM 'Community Contributor · Editorial' THEN
      RAISE EXCEPTION 'Invalid editorial provenance label'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$;

CREATE TRIGGER forum_topics_guard_editorial_author_fields
BEFORE INSERT OR UPDATE ON public.forum_topics
FOR EACH ROW EXECUTE FUNCTION public.forum_guard_editorial_author_fields();

CREATE TRIGGER forum_replies_guard_editorial_author_fields
BEFORE INSERT OR UPDATE ON public.forum_replies
FOR EACH ROW EXECUTE FUNCTION public.forum_guard_editorial_author_fields();

-- Publish the question and its first answer in one transaction. If either
-- insert fails, PostgreSQL rolls back both rows.
CREATE OR REPLACE FUNCTION public.admin_create_forum_post_pair(
  p_category_id uuid,
  p_title text,
  p_question text,
  p_answer text,
  p_question_name text,
  p_answer_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $
DECLARE
  v_topic_id uuid;
BEGIN
  IF COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(p_question_name)) NOT BETWEEN 2 AND 32
     OR char_length(btrim(p_answer_name)) NOT BETWEEN 2 AND 32 THEN
    RAISE EXCEPTION 'Editorial display names must be 2–32 characters' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.forum_topics (
    category_id, author_id, title, body, author_display_name, author_label
  ) VALUES (
    p_category_id, auth.uid(), p_title, p_question,
    btrim(p_question_name), 'Community Contributor · Editorial'
  ) RETURNING id INTO v_topic_id;

  INSERT INTO public.forum_replies (
    topic_id, author_id, body, author_display_name, author_label
  ) VALUES (
    v_topic_id, auth.uid(), p_answer,
    btrim(p_answer_name), 'Community Contributor · Editorial'
  );

  RETURN v_topic_id;
END;
$;

REVOKE ALL ON FUNCTION public.admin_create_forum_post_pair(uuid, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_forum_post_pair(uuid, text, text, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
