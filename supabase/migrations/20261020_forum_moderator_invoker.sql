-- This helper only reads the signed JWT role claim and does not need definer privileges.
CREATE OR REPLACE FUNCTION public.forum_is_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'moderator'), false);
$$;
GRANT EXECUTE ON FUNCTION public.forum_is_moderator() TO anon, authenticated;
