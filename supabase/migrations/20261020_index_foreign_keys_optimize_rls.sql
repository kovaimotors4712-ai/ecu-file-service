-- Safe performance maintenance: index uncovered foreign keys and avoid per-row auth.uid() calls in RLS.
-- No data changes. Existing access rules are preserved exactly.
BEGIN;

CREATE INDEX IF NOT EXISTS forum_reports_reply_id_idx ON public.forum_reports (reply_id);
CREATE INDEX IF NOT EXISTS forum_reports_resolved_by_idx ON public.forum_reports (resolved_by);
CREATE INDEX IF NOT EXISTS forum_reports_topic_id_idx ON public.forum_reports (topic_id);
CREATE INDEX IF NOT EXISTS notification_outbox_order_id_idx ON public.notification_outbox (order_id);
CREATE INDEX IF NOT EXISTS notifications_order_id_idx ON public.notifications (order_id);
CREATE INDEX IF NOT EXISTS order_attachments_order_owner_fk_idx ON public.order_attachments (order_id, owner_id);
CREATE INDEX IF NOT EXISTS order_attachments_uploaded_by_idx ON public.order_attachments (uploaded_by);
CREATE INDEX IF NOT EXISTS order_files_order_owner_fk_idx ON public.order_files (order_id, owner_id);
CREATE INDEX IF NOT EXISTS order_files_owner_id_idx ON public.order_files (owner_id);
CREATE INDEX IF NOT EXISTS order_files_uploaded_by_idx ON public.order_files (uploaded_by);
CREATE INDEX IF NOT EXISTS order_messages_order_customer_fk_idx ON public.order_messages (order_id, customer_id);

DROP POLICY IF EXISTS "Customers read own notifications" ON public.notifications;
CREATE POLICY "Customers read own notifications" ON public.notifications
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = customer_id);

DROP POLICY IF EXISTS "Customers update own notifications" ON public.notifications;
CREATE POLICY "Customers update own notifications" ON public.notifications
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = customer_id)
  WITH CHECK ((SELECT auth.uid()) = customer_id);

DROP POLICY IF EXISTS "Customers insert own order messages" ON public.order_messages;
CREATE POLICY "Customers insert own order messages" ON public.order_messages
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = customer_id AND sender_type = 'customer');

DROP POLICY IF EXISTS "Customers select own order messages" ON public.order_messages;
CREATE POLICY "Customers select own order messages" ON public.order_messages
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = customer_id);

DROP POLICY IF EXISTS "Customers update own order messages" ON public.order_messages;
CREATE POLICY "Customers update own order messages" ON public.order_messages
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = customer_id)
  WITH CHECK ((SELECT auth.uid()) = customer_id);

COMMIT;
