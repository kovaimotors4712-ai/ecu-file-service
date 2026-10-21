-- Prevent authenticated users from creating reports that appear already resolved.
-- Moderator-only resolution remains controlled by forum_reports_moderator_update.
BEGIN;

DROP POLICY IF EXISTS forum_reports_insert_owner ON public.forum_reports;

CREATE POLICY forum_reports_insert_owner
ON public.forum_reports FOR INSERT TO authenticated
WITH CHECK (
  reporter_id = (SELECT auth.uid())
  AND status = 'open'
  AND resolved_by IS NULL
  AND resolved_at IS NULL
  AND ((topic_id IS NOT NULL) <> (reply_id IS NOT NULL))
);

COMMIT;
