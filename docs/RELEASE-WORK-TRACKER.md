# ECU File Service India — Release Work Tracker
Updated: 2026-10-21

Repository: https://github.com/kovaimotors4712-ai/ecu-file-service
Production domain: https://ecufileservice.in
Production branch: main
Latest verified production commit: 930a76c2ea8fc09586d6b029ccf06b138552907b

## Verified in the latest production review

- Render deployment for commit 930a76c2ea8fc09586d6b029ccf06b138552907b is live.
- GitHub Actions run 39559265891 completed successfully.
- Live /api/health reports configured=true, paymentConfigured=true, schemaReady=true and serviceRoleAvailable=true. Razorpay and Resend readiness are true; PayPal readiness is false.
- Public homepage and ECU service page load over HTTPS with current neutral page titles/metadata. The exact private business-name search returns no matches in current default-branch code search results. Public search indexes and historical Git commit/PR diffs can retain older copies; do not claim historical erasure.
- robots.txt and sitemap.xml load. The sitemap currently lists nine public URLs, including /forum.html and /advertise.html.
- The live forum page loads; production database reports six active categories, zero topics and zero replies. Forum tables and policies exist in the verified Supabase project, and migration history includes forum_core_20261020. Forum is empty, not populated with sample/customer content.
- Current public database grants/RLS inspection: six internal tables have RLS enabled and zero policies; anon/authenticated SELECT and INSERT grants are false for those tables. The checkout_intents, orders, order_files, notifications and forum tables have RLS enabled and policies. Keep the existing paid-checkout SECURITY DEFINER RPC unchanged unless its authorization design is reviewed end-to-end.
- Read-only production counts: 12 notification_outbox records are SENT; one advertising payment record is cancelled; two orders currently have status Completed. These counts do not prove inbox delivery or a successful live advertising payment.
- Existing private result delivery and Razorpay checkout are preserved. Never run a real payment as a smoke test.

## Outstanding — requires credentials, account action, or a deliberate launch decision

### P0 — delivery and payments
- Email provider readiness is configured, but actual delivery to recipient inboxes and bounce/spam handling have not been independently confirmed. Check worker logs for recurring errors and verify delivery using an owner-controlled test address; do not contact customers as a test.
- PayPal is not configured in production (health reports paypal=false). Enable only after valid production credentials and a deliberate decision to support it; never invent credentials or change payment secrets without authorization.
- Advertising checkout has not been proven end-to-end with a successful authorized test payment. Do not create a real charge without explicit approval; use gateway test mode or a documented safe test procedure.
- The public health endpoint being green is not a substitute for authenticated customer/admin regression tests or full payment/download verification.

### P1 — security and database hygiene
- Supabase security advisor reports leaked-password protection disabled. Enable it in the Supabase Auth settings when the account owner can review the setting and its sign-in impact.
- Supabase advisor reports six RLS-enabled internal tables with no policies: advertising_inquiries, advertising_payment_audit, advertising_payments, advertising_quotes, notification_outbox and site_announcements. Current anon/authenticated grants for these tables are false, so do not add permissive policies just to silence the advisor. Review service-role-only access and required server paths before any policy/grant changes.
- Advisor flags public.efsi_finalize_paid_checkout as SECURITY DEFINER callable by authenticated users. This is an intentional checkout path in the current design; review function body, signature verification and ownership/amount checks before changing grants.
- Do not drop indexes solely because advisors call them unused; current usage history may be limited.
- Continue verifying private storage, order ownership, webhook idempotency and admin authorization after any code/schema change.

### P1 — forum
- Forum page is publicly readable and its database core is present, but it has no topics/replies yet. Before promoting it, test sign-in, profile ownership, topic/reply creation, rate limits, reporting privacy and moderator-only actions with ordinary and moderator accounts.
- Do not seed fake posts or accept ECU binaries, private download links or customer-identifying data as forum attachments.

### P1 — store and membership
- Store and membership pages are present in the sitemap, but full purchase, entitlement, download-limit and expiry workflows have not been verified end-to-end. Do not advertise paid plans/items as fully operational until the entire flow passes.
- Keep licensed files private and publish no item until commercial redistribution rights are documented.

### P2 — SEO and legal launch readiness
- robots.txt and sitemap.xml are reachable; Search Console indexing status for every URL is not confirmed. A prior indexing request is not confirmed as completed.
- Privacy, Terms and Refund pages require review against actual business practices and applicable law before publication.
- Recheck canonical URLs, sitemap membership and noindex behavior after route changes.

## Security and release guardrails

- Keep https://ecufileservice.in unchanged.
- Never expose or commit service-role keys, database passwords, payment secrets or customer files.
- Never apply migrations blindly or against a different/inactive Supabase project.
- Preserve the private-ecu-files bucket, existing order/payment tables and checkout path.
- After each release, run tests and syntax checks, inspect the exact diff, verify the live Render deployment/health, and validate payment and private-file delivery without creating unauthorized real charges.
