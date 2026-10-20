# ECU File Service India — Release Work Tracker
Updated: 2026-10-20

Repository: https://github.com/kovaimotors4712-ai/ecu-file-service
Production domain: https://ecufileservice.in
Production branch: main
Current production commit: 6f3558c26194d0666e11f573f0bc9a1242022241

## Completed and verified

- GitHub Actions runs the existing Node.js suite plus syntax checks for the server, front-end scripts, and staged forum client.
- CI passed on the current forum-stage merge: npm test and all JavaScript syntax checks.
- Render deployed the forum-stage commit successfully. Live API health reports configured=true, paymentConfigured=true, Razorpay ready, schemaReady=true and serviceRoleAvailable=true.
- Baseline browser security headers are present in the server response code. Regression tests cover customer and admin HTML responses.
- Checkout insert failure responses use a customer-safe generic error rather than returning raw PostgREST/schema details.
- Public diagnostic guides are live at https://ecufileservice.in/guides.html; the sitemap lists the homepage, two service pages, and the Guides page.
- A narrow manual grant of SELECT and UPDATE on public.notification_outbox to service_role was run in the Supabase SQL Editor; the privilege query returned can_select=true and can_update=true.
- A worker log after the grant showed Queue batch found { count: 10 }. Continue observing later worker runs; this is not proof of successful email delivery.
- Forum preparation is merged in a gated state: UI/client, additive RLS/rate-limit migration, verification SQL and staging documentation are present in the repository. It is deliberately not enabled as a public route.
- Forum security regression tests check that forum HTML, JS, CSS and migration files remain inaccessible over HTTP before database verification.
- Existing ECU checkout, Razorpay finalization and private result-delivery code were not changed by the staged forum feature.

## Pending — do not bypass these gates

### P0 — production database and notifications
- Supabase connector methods still return the eligible linked-account error. The correct project is visible in the user's Supabase dashboard, but connector-side migration/schema inspection is unavailable.
- Before applying schema changes, confirm production project identity and inspect migration history, existing tables, RLS, storage policies, security/performance advisors and a verified recovery point.
- The manual notification_outbox grant succeeded, but migration history has not been reconciled with the manual change. Continue checking worker logs for recurring 403s and confirm actual notifications are delivered idempotently.
- The additive forum migration has not been applied to any database. Review and apply only once in the verified project, then run supabase/verify_forum_core.sql and test with normal and moderator accounts.

### P1 — Forum launch
- forum.html, forum.css and forum.js are in the repository but are not in the public-file allowlist, homepage navigation or sitemap; the public forum route intentionally returns 404.
- After the database migration is verified, test sign-in/sign-up, profile ownership, category/topic/reply operations, rate limits, self-report rejection, report confidentiality and moderator-only actions. Only then enable the route and navigation in a separate change.
- No forum attachment uploads exist. Do not accept ECU binaries, private download links or customer-identifying data through the forum.

### P1 — Licensed Store and Membership
- Store/Membership UI and server integration have not been deployed. Integrate separately without changing the existing ECU checkout/payment finalizer.
- Keep licensed-store-files private. Verify payment signatures/amounts, duplicate callbacks, ownership, download limits, membership expiry and RLS before launch.
- Publish no item until lawful commercial redistribution rights are documented. No products or plans are seeded.

### P2 — SEO, legal pages and launch
- Privacy, Terms and Refund pages remain drafts. Review against real business practices and applicable law before making them public.
- Add new URLs to sitemap only when those routes are actually live and tested.
- After each release, run the repository suite, inspect the exact diff, verify Render deployment and health, check payment and private-file delivery, then verify rollback readiness.

## Security guardrails

- Keep https://ecufileservice.in unchanged.
- Never request, expose, or commit service-role keys, database passwords, Razorpay secrets or customer files.
- Never apply migrations blindly or to a different/inactive Supabase project.
- Preserve the private-ecu-files bucket, payment/order tables and existing checkout path.
- Static/package tests and a healthy health endpoint do not prove full database authorization or end-to-end security.
