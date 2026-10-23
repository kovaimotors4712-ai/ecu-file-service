-- Add indexes for foreign keys identified by Supabase performance advisor.
-- Additive and safe: no data changes, payment behavior changes, or policy changes.
BEGIN;
CREATE INDEX IF NOT EXISTS forum_topics_accepted_reply_id_idx
  ON public.forum_topics (accepted_reply_id)
  WHERE accepted_reply_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_public_settings_updated_by_idx
  ON public.site_public_settings (updated_by)
  WHERE updated_by IS NOT NULL;
COMMIT;
