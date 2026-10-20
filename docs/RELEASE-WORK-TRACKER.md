# ECU File Service India — Release Work Tracker
Updated: 2026-10-20

Repository: https://github.com/kovaimotors4712-ai/ecu-file-service
Production domain: https://ecufileservice.in
Production branch: `main`
Working branch: `codex/global-forum-release-2026-10-20`
Base commit: `fb3c494446b9c0b9d7e9d51939460e2427ca683d`

## Completed safely
- [x] GitHub connector write access verified by creating and reading the working branch.
- [x] `main` remains unchanged; Render auto-deploy is configured for `main`, not this working branch.
- [x] Prepared release candidate for Forum/Guides/SEO/Admin, licensed Store and fixed-term Membership.
- [x] Release candidate static checks passed: 29 combined release checks and 41 Store/Membership checks. These are package/static checks, not a live database verification or full production-source test.
- [x] Prepared a narrow notification-worker permission migration for review. It has **not** been applied to Supabase.

## Pending — in priority order

### P0 — Supabase connection and notification worker
- [ ] Restore an eligible ChatGPT Supabase connector link for the actual project `kbpdapxpvcyysjilmhch`. The latest connector call returns `link_id must identify an eligible linked account`; earlier calls denied project access.
- [ ] Confirm this project is the same database used by Render, and verify project status, migrations, tables and RLS.
- [ ] Take/verify a recovery point before DDL.
- [ ] Apply the prepared notification-outbox permission migration only after the checks above; then inspect Render logs and confirm the `notification_outbox` 403 stops.

### P1 — Forum / learning guides
- [ ] Install the forum and guide UI into the app with correct navigation.
- [ ] Apply the forum core migration only after migration history/schema checks.
- [ ] Verify account ownership, RLS, reporting, moderation, search and rate limits against the real database.

### P1 — Licensed Store / Membership
- [ ] Integrate Store UI and server handlers without changing the existing ECU checkout/payment finalizer.
- [ ] Verify the `licensed-store-files` bucket remains private; test verified Razorpay payment, invalid/duplicate callbacks, amount mismatch, ownership, download limits and membership expiry.
- [ ] Publish no product until evidence of lawful redistribution rights is recorded. No products are seeded.

### P2 — SEO / policies / launch
- [ ] Connect SEO sitemap/canonical/meta and policy pages to the actual public routes; validate sitemap URLs on the live domain.
- [ ] Review Privacy, Terms and Refund policy drafts against the real business and applicable legal obligations before publication.
- [ ] Run the real repository `npm test` after integration; review the diff, then merge only after all release gates pass.
- [ ] Verify Render deployment, `/api/health`, payments, private file delivery, notifications, mobile/desktop UI and rollback readiness.

## Guardrails
- Never commit directly to `main` or trigger production deploy during this staged work.
- Never apply SQL to the inactive/unverified project `jxwjjuvnwtjmdxruoohy`.
- Do not rerun historical/base migrations blindly.
- Do not expose or request Supabase service-role keys, database passwords, Razorpay secrets or other credentials in chat.
- Preserve the existing `private-ecu-files` bucket, order/payment tables and verified checkout flow.
