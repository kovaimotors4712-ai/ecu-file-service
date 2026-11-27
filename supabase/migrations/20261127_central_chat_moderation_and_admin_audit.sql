-- Add reversible moderation state to live chat and prepare the existing
-- community audit trail for centralized admin activity logging.
-- Additive only: no existing messages are deleted or modified.
-- This migration is committed to a feature branch only; do not apply to production
-- until the API/UI implementation and tests have been reviewed.

begin;

alter table public.forum_chat_messages
  add column if not exists is_hidden boolean not null default false,
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references auth.users(id) on delete set null;

create index if not exists forum_chat_messages_visible_created_idx
  on public.forum_chat_messages (created_at desc)
  where is_hidden = false;

create index if not exists forum_chat_messages_hidden_created_idx
  on public.forum_chat_messages (created_at desc)
  where is_hidden = true;

-- Public visitors and ordinary members see visible messages only.
-- Authors retain access to their own hidden messages; moderators can review all.
drop policy if exists forum_chat_read_public on public.forum_chat_messages;
create policy forum_chat_read_public
on public.forum_chat_messages
for select to anon, authenticated
using (
  is_hidden = false
  or author_id = (select auth.uid())
  or public.forum_is_moderator()
);

-- Table privilege enables the operation; the RLS policy below restricts it
-- to trusted admins/moderators only.
grant update on public.forum_chat_messages to authenticated;

-- Only trusted admins/moderators can hide or restore chat messages.
drop policy if exists forum_chat_moderator_update on public.forum_chat_messages;
create policy forum_chat_moderator_update
on public.forum_chat_messages
for update to authenticated
using (public.forum_is_moderator())
with check (public.forum_is_moderator());

-- The existing community_admin_audit table already has the required actor,
-- action, target, JSON details and timestamp fields. Reuse it as the single
-- activity log rather than creating a duplicate log table.
create index if not exists community_admin_audit_target_created_idx
  on public.community_admin_audit (target_type, created_at desc);

comment on table public.community_admin_audit is
  'Central admin/moderator activity log for community moderation and other administrative actions.';

comment on column public.forum_chat_messages.is_hidden is
  'When true, the message is hidden from public chat but retained for review and possible restoration.';

commit;
