# ECU FILE SERVICE INDIA

A responsive ECU File Service India storefront and admin console for ECU file services and Airbag Crash Clear. Historical Dashboard orders remain in the database and admin order history.

## Current architecture

The application is a single Node.js HTTP server with a static customer/admin frontend, Supabase Auth/PostgREST/Realtime/Private Storage, Razorpay + PayPal server-side payment handling, and Resend email notifications.

The production payment flow is intentionally server-authoritative:

1. Customer signs in and completes the request form.
2. The browser creates a durable Supabase-backed checkout intent through the server.
3. The original file is uploaded directly to the private `private-ecu-files` bucket using the authenticated customer's Supabase session.
4. The server verifies the private object by size and SHA-256 before payment can proceed.
5. Razorpay or PayPal creates the provider checkout/order from the durable intent.
6. Payment is independently verified/captured server-side.
7. A provider-neutral, HMAC-bound Supabase RPC finalizes the paid order and links the already-staged private original file.
8. Admin notification events are written to `notification_outbox`; the server worker delivers them through Resend without blocking payment/order finalization.
9. Customer and admin order views use Supabase Realtime for status/file changes.

The original upload never travels through a Base64 JSON field or through a permanent server filesystem. Shared identical files use a content-addressed storage path based on SHA-256 so multiple orders can reference the same private object.

## Customer form rules

**ECU** requests collect:
- Brand
- Vehicle Type
- Model
- Year
- ECU Manufacturer
- ECU Model/Type
- Reading Tool
- File Services

**Airbag Crash Clear** requests collect:
- Brand, vehicle type, model and required year
- Airbag module details
- Required module photo and part-number label photo (JPG/PNG/WEBP, up to 10 MB each)
- The single Airbag service: `Crash Clear`
- Original file and contact details (valid email required for notifications)

Dashboard is no longer offered for new orders. Historical Dashboard records are retained for admin review.

The server normalizes fields and validates the Airbag photo sizes, MIME types, storage paths, and SHA-256 hashes before payment can begin.

## Customer account

Customers can open **My account** to see:
- saved/incomplete checkouts
- payment status
- order/service status
- payment provider/reference
- processed-file availability
- private processed-file download

Incomplete checkout records live in Supabase and can be resumed after browser close/reopen or a server restart. Pending provider payments can be reconciled without asking the customer to pay again.

## Admin console

Open `/admin.html` with a Supabase Auth account whose trusted `app_metadata.role` is `admin`.

The admin dashboard supports an explicit service-status selector:

`New` · `File Review` · `Processing` · `Possible` · `Not Possible` · `Completed` · `Cancelled` · `Payment Pending`

The server rejects unauthorized status changes and the database requires a processed file before `Completed`.

## Supabase migration order

For an existing production deployment, do not rerun the base migrations. After deploying this application code to Render, apply the following new migrations in timestamp order from the Supabase SQL Editor:

1. `supabase/migrations/20261014_email_notifications.sql` — adds idempotent event keys, payment/status events, and separate Admin/customer Resend notifications.
2. `supabase/migrations/20261015_airbag_crash_clear.sql` — adds private order attachments, Airbag module details, secure photo-storage policy extensions, and the compatible paid-checkout finalizer.

Deploy code first, then apply both new migrations promptly. Until the second migration is applied, Airbag photo uploads remain blocked by the previous private-storage policy; do not accept live Airbag orders during that short transition. Existing ECU checkout/payment validation stays server-authoritative. Do not apply migrations 20260924 or 20261004 to a database where they have already been applied.

`20260924_razorpay_payment_gate.sql` is intentionally a superseded marker and must **not** be applied as a second payment schema.

The new migrations do not drop the Supabase Realtime publication. Review backups and confirm each migration finishes successfully before moving to the next.

### Vault proof secret

Create a separate random secret of at least 32 characters and store it in Supabase Vault under:

`efsi_payment_gate_proof_secret`

Set the same value in the server-only environment variable `PAYMENT_GATE_PROOF_SECRET`.

Do not put the proof secret, Supabase service-role key, Razorpay secret or PayPal secret in browser JavaScript, HTML, Git, or chat.

After the migration and Vault secret have been verified, set:

`PAYMENT_GATE_SCHEMA_READY=true`

## Environment variables

Copy `.env.example` for local development. Production uses the same variable names through Render Environment Variables.

Required server-side configuration:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY

RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=YOUR_RAZORPAY_SECRET

PAYPAL_CLIENT_ID=YOUR_PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET=YOUR_PAYPAL_CLIENT_SECRET
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com

RESEND_API_KEY=re_...
EMAIL_FROM=ECU FILE SERVICE INDIA <noreply@YOUR_VERIFIED_DOMAIN>
ADMIN_NOTIFICATION_EMAIL=YOUR_ADMIN_EMAIL@example.com

PAYMENT_GATE_PROOF_SECRET=YOUR_RANDOM_32_PLUS_CHARACTER_SECRET
PAYMENT_GATE_SCHEMA_READY=false
PUBLIC_APP_URL=https://ecufileservice.in
```

For production, use live Razorpay credentials, `https://api-m.paypal.com`, a verified Resend sender domain, and `PAYMENT_GATE_SCHEMA_READY=true` only after the migration/Vault checks pass.

## Local run and tests

Use Node.js 18+.

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4173`.

Run automated checks:

```powershell
npm test
```

Run the checkout UI-only development server when needed:

```powershell
$env:NODE_ENV = 'development'
npm run checkout:test
```

Never deploy the development bypass. It is only for local UI testing.

## Deployment checklist

1. Apply the base migration and final `20261004_updates.sql` migration to the target Supabase project.
2. Put the proof secret in Supabase Vault as `efsi_payment_gate_proof_secret`.
3. Configure Render Environment Variables from `.env.production.example`.
4. Keep both Razorpay and PayPal credentials in the intended mode; do not mix test and live credentials.
5. Configure Resend with a verified sender domain and admin inbox.
6. Set `PAYMENT_GATE_SCHEMA_READY=true` only after the database/Vault verification succeeds.
7. Confirm `/api/health` reports the expected provider/readiness flags.
8. Test one Razorpay payment and one PayPal sandbox/test transaction before enabling live customer traffic.

## Security notes

- Private ECU storage remains non-public.
- Customer order reads are ownership-scoped.
- Customers do not have a direct order-insert policy.
- Paid orders are finalized only by the verified payment RPC.
- Admin authorization is server-side and backed by trusted Supabase `app_metadata.role`.
- Payment requests are bound to the authenticated customer, checkout intent, amount/currency and original-file/request hashes.
- Duplicate payment callbacks are idempotent.
- Abandoned checkout intents and unreferenced staged objects are cleaned up by the server worker.
- The server never exposes environment files, migration files, fixtures, or service credentials as public assets.


## Deploy and verify

- Keep Render secrets in the Render Environment dashboard; never place production secrets in this repository or the ZIP.
- Set `RESEND_API_KEY`, `EMAIL_FROM` (a sender/domain verified in Resend), and `ADMIN_NOTIFICATION_EMAIL` in Render.
- Set `PUBLIC_APP_URL=https://ecufileservice.in`; keep the existing domain and DNS.
- Run `npm test` before deployment. The tests use local mocked Razorpay/PayPal/Resend providers and do not initiate real payments.
- After both migrations finish, confirm `/api/health` reports payment readiness and check the notification outbox in Supabase.
- Submit `https://ecufileservice.in/sitemap.xml` in Google Search Console after deployment. Indexing/rankings are controlled by search engines and are not guaranteed.
