-- Read-only verification for the staged forum migration.
-- Run only in the confirmed production Supabase project AFTER reviewing/applying the migration.
-- This file contains SELECT statements only; it does not change schema, privileges, or data.

WITH required(table_name) AS (
  VALUES ('forum_categories'), ('forum_profiles'), ('forum_topics'), ('forum_replies'), ('forum_reports')
)
SELECT
  r.table_name,
  to_regclass(format('public.%I', r.table_name)) IS NOT NULL AS table_exists,
  coalesce(c.relrowsecurity, false) AS rls_enabled,
  coalesce(c.relforcerowsecurity, false) AS force_rls
FROM required r
LEFT JOIN pg_class c ON c.relname = r.table_name
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.oid IS NULL OR n.oid IS NOT NULL
ORDER BY r.table_name;

WITH expected(table_name, policy_name) AS (
  VALUES
    ('forum_categories','forum_categories_read_active'),
    ('forum_profiles','forum_profiles_read_public'),
    ('forum_profiles','forum_profiles_insert_owner'),
    ('forum_profiles','forum_profiles_update_owner'),
    ('forum_topics','forum_topics_read_visible'),
    ('forum_topics','forum_topics_insert_owner'),
    ('forum_topics','forum_topics_moderator_update'),
    ('forum_replies','forum_replies_read_visible'),
    ('forum_replies','forum_replies_insert_owner'),
    ('forum_replies','forum_replies_moderator_update'),
    ('forum_reports','forum_reports_read_own_or_moderator'),
    ('forum_reports','forum_reports_insert_owner'),
    ('forum_reports','forum_reports_moderator_update')
)
SELECT
  e.table_name,
  e.policy_name,
  p.policyname IS NOT NULL AS policy_exists,
  p.roles,
  p.cmd,
  p.qual AS using_expression,
  p.with_check AS with_check_expression
FROM expected e
LEFT JOIN pg_policies p
  ON p.schemaname = 'public'
 AND p.tablename = e.table_name
 AND p.policyname = e.policy_name
ORDER BY e.table_name, e.policy_name;

WITH expected(trigger_name, table_name) AS (
  VALUES
    ('forum_profiles_touch_updated_at','forum_profiles'),
    ('forum_topics_touch_updated_at','forum_topics'),
    ('forum_replies_touch_updated_at','forum_replies'),
    ('forum_topics_rate_limit','forum_topics'),
    ('forum_replies_rate_limit','forum_replies'),
    ('forum_reports_rate_limit','forum_reports'),
    ('forum_reports_validate_target','forum_reports')
)
SELECT
  e.table_name,
  e.trigger_name,
  t.oid IS NOT NULL AS trigger_exists,
  CASE WHEN t.oid IS NOT NULL THEN pg_get_triggerdef(t.oid, true) END AS trigger_definition
FROM expected e
LEFT JOIN pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = e.table_name
LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = e.trigger_name AND NOT t.tgisinternal
ORDER BY e.table_name, e.trigger_name;

WITH expected(function_name) AS (
  VALUES
    ('forum_is_moderator'),
    ('forum_touch_updated_at'),
    ('forum_enforce_rate_limit'),
    ('forum_validate_report_target')
)
SELECT
  e.function_name,
  p.oid IS NOT NULL AS function_exists,
  p.prosecdef AS security_definer,
  p.proconfig AS function_configuration,
  CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon', p.oid, 'EXECUTE') END AS anon_can_execute,
  CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated', p.oid, 'EXECUTE') END AS authenticated_can_execute
FROM expected e
LEFT JOIN pg_proc p ON p.proname = e.function_name
LEFT JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
WHERE p.oid IS NULL OR n.oid IS NOT NULL
ORDER BY e.function_name;

SELECT
  has_table_privilege('anon', 'public.forum_categories', 'SELECT') AS anon_can_read_categories,
  has_table_privilege('anon', 'public.forum_profiles', 'SELECT') AS anon_can_read_public_profiles,
  has_table_privilege('anon', 'public.forum_topics', 'SELECT') AS anon_can_read_topics,
  has_table_privilege('anon', 'public.forum_replies', 'SELECT') AS anon_can_read_replies,
  has_table_privilege('anon', 'public.forum_reports', 'SELECT') AS anon_can_read_reports,
  has_table_privilege('authenticated', 'public.forum_topics', 'INSERT') AS signed_in_role_can_submit_topics,
  has_table_privilege('authenticated', 'public.forum_replies', 'INSERT') AS signed_in_role_can_submit_replies,
  has_table_privilege('authenticated', 'public.forum_reports', 'INSERT') AS signed_in_role_can_submit_reports,
  has_table_privilege('authenticated', 'public.forum_reports', 'UPDATE') AS signed_in_role_has_report_update_grant;
-- Table privileges above are not proof of row access: RLS policies remain authoritative.

SELECT count(*) >= 6 AS at_least_six_seeded_categories, count(*) AS category_count
FROM public.forum_categories;

SELECT slug, title, is_active, sort_order
FROM public.forum_categories
ORDER BY sort_order, title;
