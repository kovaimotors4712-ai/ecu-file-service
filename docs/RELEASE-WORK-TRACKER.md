# ECU File Service India — Release Work Tracker
Updated: 2026-10-20

Repository: https://github.com/kovaimotors4712-ai/ecu-file-service  
Production domain: https://ecufileservice.in  
Production branch: `main`

## Completed
- GitHub Actions now runs `npm test` and syntax checks for the main JavaScript files. CI-only PR #3 was merged after push and pull-request checks passed.
- The CI-only commit deployed successfully to Render.
- Live `/api/health` returned configured=true, paymentConfigured=true, razorpay=true, schemaReady=true, and serviceRoleAvailable=true.
- Supabase SQL Editor showed `notification_outbox` exists. Manual grant of `SELECT, UPDATE` to `service_role` succeeded; follow-up privilege query returned `can_select=true`, `can_update=true`.
- Render's last observed worker log after the grant showed `Queue batch found { count: 10 }`. An earlier 403 was from the previous worker attempt; keep monitoring for recurrence.
- Original ECU checkout and private result delivery code were not changed by the CI-only release.
- Public diagnostic Guides page is live at `/guides.html`; its stylesheet, homepage navigation, sitemap entry and regression tests were merged after push and PR CI passed.
- Checkout insert failure messages now return a generic customer-safe error; diagnostic logging retains only HTTP status and a bounded error code instead of raw PostgREST error details.
- The latest inspected Render log window had no new `notification_outbox` permission error after the manual grant; continue monitoring actual notification delivery.

## In progress
- Safe public diagnostic-guides page: add only the educational page, its stylesheet, navigation, server static allowlist, sitemap entry and regression tests. Do not link to the Forum/Store until those pages are actually integrated and tested.

## Pending — do not bypass these gates
### P0 — database and notifications
- Supabase connector calls still return `link_id must identify an eligible linked account`; inspect the database through the authenticated Supabase dashboard until connector access is repaired.
- Confirm the production project and review migration history, core tables, RLS and storage policies.
- Create/verify a recovery point before applying any schema migration.
- Continue checking Render logs to ensure `notification_outbox` permission errors do not recur; update the migration tracking only after deciding how to reconcile the manual grant with migration history.

### P1 — Forum and educational platform
- Integrate Forum UI and endpoints only after verifying current auth, ownership checks, RLS, report/moderation flow, spam/rate limits and search against the real database.
- Do not publish UI links to endpoints that still return 404.

### P1 — Licensed Store and Membership
- Integrate store server handlers without changing the existing ECU checkout/payment finalizer.
- Keep `licensed-store-files` private and test verified payment, amount mismatch, duplicate callbacks, user ownership, download limits and expiry.
- Publish no product until lawful commercial redistribution authorization is documented. No product binaries or plans are seeded.

### P2 — SEO, legal pages and release
- Validate sitemap URLs after the Guides page deploys.
- Privacy, Terms and Refund pages remain drafts until reviewed against actual business practices and applicable legal requirements.
- Run actual repository tests and inspect PR diff before merging each feature. Recheck Render health, existing Razorpay flow and private file download after deployment.

## Security guardrails
- Keep `https://ecufileservice.in` unchanged.
- Never expose, request in chat, or commit service-role keys, database passwords, Razorpay secrets or customer files.
- Do not apply migrations blindly or to an inactive/unverified project.
- Preserve the `private-ecu-files` bucket, order/payment tables and existing checkout flow.
- A passing static/package test is not a substitute for database integration, authorization, or end-to-end production testing.


## Forum staged release (2026-10-20)
- A dedicated forum branch is being prepared with public topic/category reading, sign-in/profile flow, topic/reply creation, private abuse reports, moderator actions, and an additive forum-only migration.
- The forum page, CSS and JavaScript are allowlisted explicitly; the existing static-file allowlist continues to block arbitrary files and migration paths.
- The branch must not be merged/deployed until the forum migration is reviewed/applied on the verified production Supabase project and RLS, profile ownership, reply ownership, reporting privacy, moderation and rate limits are integration-tested.
- No store purchase flow is included in this forum stage. Existing ECU checkout, Razorpay verification, order tables and private ECU file delivery are not intentionally modified.
