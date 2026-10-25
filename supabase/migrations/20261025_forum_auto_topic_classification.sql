-- Automatically promote sufficiently detailed, clearly classified public chat messages into searchable forum topics.
-- Existing chat and topic data remain intact; each source chat message can create at most one topic.
BEGIN;

ALTER TABLE public.forum_topics
  ADD COLUMN IF NOT EXISTS source_chat_message_id uuid
  REFERENCES public.forum_chat_messages(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS forum_topics_source_chat_message_uidx
  ON public.forum_topics(source_chat_message_id)
  WHERE source_chat_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS forum_topics_search_text_idx
  ON public.forum_topics USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,'')))
  WHERE is_hidden = false;

NOTIFY pgrst, 'reload schema';
COMMIT;
