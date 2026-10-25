-- Add an index for the category_id foreign key used by forum auto-topic signals.
-- This migration has already been applied to the production database.
create index if not exists forum_auto_topic_signals_category_id_idx
  on public.forum_auto_topic_signals (category_id);
