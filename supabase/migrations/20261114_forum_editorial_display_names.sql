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

NOTIFY pgrst, 'reload schema';
COMMIT;
