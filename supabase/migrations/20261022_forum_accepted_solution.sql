-- Accepted solution support for workshop forum. Additive and isolated from payments.
BEGIN;
ALTER TABLE public.forum_topics
  ADD COLUMN IF NOT EXISTS accepted_reply_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'forum_topics_accepted_reply_fk'
      AND conrelid = 'public.forum_topics'::regclass
  ) THEN
    ALTER TABLE public.forum_topics
      ADD CONSTRAINT forum_topics_accepted_reply_fk
      FOREIGN KEY (accepted_reply_id) REFERENCES public.forum_replies(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.forum_set_accepted_reply(p_topic_id uuid, p_reply_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  topic_author uuid;
  reply_topic uuid;
  chosen uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in is required.' USING ERRCODE = '42501';
  END IF;

  SELECT t.author_id INTO topic_author
  FROM public.forum_topics AS t
  WHERE t.id = p_topic_id AND NOT t.is_hidden
  FOR UPDATE;

  IF topic_author IS NULL THEN
    RAISE EXCEPTION 'Topic not found.' USING ERRCODE = 'P0002';
  END IF;
  IF topic_author <> auth.uid() THEN
    RAISE EXCEPTION 'Only the topic author can accept a solution.' USING ERRCODE = '42501';
  END IF;

  IF p_reply_id IS NOT NULL THEN
    SELECT r.topic_id INTO reply_topic
    FROM public.forum_replies AS r
    WHERE r.id = p_reply_id AND NOT r.is_hidden;
    IF reply_topic IS DISTINCT FROM p_topic_id THEN
      RAISE EXCEPTION 'Choose a visible reply from this topic.' USING ERRCODE = '22023';
    END IF;
    chosen := p_reply_id;
  END IF;

  UPDATE public.forum_topics
  SET accepted_reply_id = chosen
  WHERE id = p_topic_id;

  RETURN chosen;
END;
$$;
REVOKE ALL ON FUNCTION public.forum_set_accepted_reply(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forum_set_accepted_reply(uuid, uuid) TO authenticated;
COMMIT;
