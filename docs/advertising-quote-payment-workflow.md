# Advertising quotation and payment workflow

## Status

Design plan only. This document does not enable advertising payments or change production behavior. The current advertiser enquiry form remains an enquiry-only flow.

## Goals

- Let an administrator review an advertiser enquiry and issue a written quote with a price, currency, placement, start/end dates, creative requirements, and expiry.
- Let the advertiser accept that specific quote and pay through Razorpay.
- Publish an advertisement only after the server has verified payment and the approved publication window.
- Keep the existing ECU-file checkout, orders, and payment verification flow unchanged.

## Proposed separate data model

Create a separate advertising domain rather than reusing `orders`, `checkout_intents`, or ECU file payment metadata.

- `advertising_quotes`: enquiry reference, quote version, amount in paise (integer), currency (INR), placement, start/end timestamps, quote expiry, terms snapshot, status, admin actor, timestamps.
- `advertising_payments`: quote reference, Razorpay order ID, Razorpay payment ID, amount/currency snapshot, verification status, verified timestamp, idempotency key, timestamps.
- Link a published `site_announcements` row to the paid quote/payment, with a constraint or server-side invariant that only a verified, paid quote can authorize an ad publication.

Keep RLS enabled. Grant table access only to the server service role; do not grant anon/authenticated direct access. All admin actions must use the existing `requireAdmin` check.

## Required quote lifecycle

`enquiry new → contacted → quote issued → advertiser accepts quote → payment pending → payment verified → scheduled/published → expired/closed`

Declined, expired, cancelled, and failed-payment states must be explicit. A quote must become immutable once a payment order is created; changes require a new quote version.

## Payment safety requirements

1. The browser never supplies the amount used to create a Razorpay order. The server reads the persisted approved quote and uses integer paise.
2. Create a Razorpay order only for an unexpired, accepted quote with no existing active payment attempt, using a unique idempotency strategy.
3. Verify the Razorpay signature server-side using the existing configured secret. Never trust a browser success callback as proof of payment.
4. Where webhooks are added, verify the webhook signature against the raw request body, deduplicate event IDs, and reconcile with Razorpay before marking paid.
5. Verify amount, currency, Razorpay order ID, quote status, and payment status together. Reject mismatches and replayed or conflicting payments.
6. A successful payment must not itself bypass ad review. Publication requires verified payment plus approved creative, valid HTTPS destinations, and a valid date window.
7. Never auto-publish an unreviewed creative. Do not expose service-role credentials or payment secrets to the browser.
8. Keep advertiser payment state and content publication state separate so a paid ad can remain unpublished pending creative approval.
9. Add rate limits and audit records for quote issuance, quote changes, payment attempts, payment verification, and publication.
10. No new paid workflow goes live until migrations are applied, tests pass, and test-mode end-to-end verification is complete.

## Admin workflow

- View enquiry details and set a review status.
- Enter a quote amount (INR), placement, duration, quote expiry, and written terms; the system records the admin and version.
- Send the quote through the configured email provider only after validating delivery configuration; display a safe status if email delivery fails.
- View payment verification and creative approval separately.
- Approve and schedule the creative only after payment verification; support unpublish/expiry and retain an audit trail.

## Implementation sequence

1. Add migration and schema tests for the isolated quote/payment tables and service-role-only grants.
2. Add server-side quote CRUD endpoints guarded by `requireAdmin`, with strict validation and immutable quote snapshots.
3. Add advertiser quote viewing/acceptance using an opaque, expiring token; store only a hash of the token.
4. Add Razorpay order creation and verification dedicated to advertising, with idempotency and amount/currency checks.
5. Add admin UI for quote management, payment status, creative approval, and scheduled publication.
6. Add tests for unauthorized access, quote expiry/version changes, amount tampering, signature failures, duplicate callbacks/webhooks, payment mismatch, unapproved creative, and publication windows.
7. Deploy only after CI and test-mode end-to-end checks pass. Keep the existing ECU-file checkout regression suite green.

## Explicitly out of scope until confirmed

- Default advertising rates or packages.
- GST/tax treatment, refund/cancellation policy, ad guarantees, or legal terms.
- Automatic publication immediately after payment.
- Changes to the existing ECU-file checkout or customer order tables.
