-- Allow the authenticated server-side admin endpoint to delete announcements.
-- Public/anon/authenticated roles receive no DELETE privilege.
grant delete on table public.site_announcements to service_role;
