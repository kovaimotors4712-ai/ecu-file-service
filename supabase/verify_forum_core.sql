-- Read-only verification for 20261020_forum_core.sql.
-- Run only in the verified production project after the migration has been reviewed/applied.
SELECT
  to_regclass('public.forum_categories') AS forum_categories,
  to_regclass('public.forum_profiles') AS forum_profiles,
  to_regclass('public.forum_topics') AS forum_topics,
  to_regclass('public.forum_replies') AS forum_replies,
  to_regclass('public.forum_reports') AS forum_reports;

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('forum_categories','forum_profiles','forum_topics','forum_replies','forum_reports')
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('forum_categories','forum_profiles','forum_topics','forum_replies','forum_reports')
ORDER BY tablename, policyname;

SELECT slug, title, is_active
FROM public.forum_categories
ORDER BY sort_order, title;
