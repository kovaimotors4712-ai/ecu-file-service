-- Improve workshop/community foreign-key lookup performance and avoid per-row auth.uid() evaluation.
-- Policy predicates retain the same ownership and moderation boundaries.
begin;
create index if not exists community_admin_audit_actor_id_idx on public.community_admin_audit(actor_id);
create index if not exists workshop_reports_reporter_id_idx on public.workshop_reports(reporter_id);
create index if not exists workshop_reports_resolved_by_idx on public.workshop_reports(resolved_by);
create index if not exists workshop_reports_review_id_idx on public.workshop_reports(review_id);
create index if not exists workshop_reports_workshop_id_idx on public.workshop_reports(workshop_id);
create index if not exists workshop_reviews_reviewer_id_idx on public.workshop_reviews(reviewer_id);

drop policy if exists workshops_owner_read on public.workshops;
create policy workshops_owner_read on public.workshops for select to authenticated using (owner_id=(select auth.uid()));
drop policy if exists workshops_owner_insert_pending on public.workshops;
create policy workshops_owner_insert_pending on public.workshops for insert to authenticated with check (owner_id=(select auth.uid()) and status='pending' and is_verified=false);
drop policy if exists workshops_owner_update_pending on public.workshops;
create policy workshops_owner_update_pending on public.workshops for update to authenticated using (owner_id=(select auth.uid()) and status in ('pending','rejected')) with check (owner_id=(select auth.uid()) and status in ('pending','rejected') and is_verified=false);

drop policy if exists workshop_reviews_owner_read on public.workshop_reviews;
create policy workshop_reviews_owner_read on public.workshop_reviews for select to authenticated using (reviewer_id=(select auth.uid()));
drop policy if exists workshop_reviews_owner_insert on public.workshop_reviews;
create policy workshop_reviews_owner_insert on public.workshop_reviews for insert to authenticated with check (reviewer_id=(select auth.uid()) and status='pending');
drop policy if exists workshop_reviews_owner_update_pending on public.workshop_reviews;
create policy workshop_reviews_owner_update_pending on public.workshop_reviews for update to authenticated using (reviewer_id=(select auth.uid()) and status='pending') with check (reviewer_id=(select auth.uid()) and status='pending');

drop policy if exists workshop_reports_insert_own on public.workshop_reports;
create policy workshop_reports_insert_own on public.workshop_reports for insert to authenticated with check (reporter_id=(select auth.uid()) and status='open' and resolved_by is null and resolved_at is null);
drop policy if exists workshop_reports_read_own on public.workshop_reports;
create policy workshop_reports_read_own on public.workshop_reports for select to authenticated using (reporter_id=(select auth.uid()));
commit;
