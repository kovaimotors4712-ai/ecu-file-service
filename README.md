# ECU FILE SERVICE INDIA

A responsive customer storefront and admin console for ECU, airbag and dashboard file-service requests.

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

**Airbag** and **Dashboard / Cluster** requests collect only:
- Brand
- Vehicle Type
- Model
- Year

The server normalizes these fields as well, so hidden/disabled ECU-only fields cannot be smuggled into an Airbag or Dashboard order.

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

Apply these migrations in order:

1. `supabase/migrations/20260924_ecu_file_service.sql` — base schema.
2. `supabase/migrations/20261004_updates.sql` — final provider-neutral payment/check-out/storage/realtime/email/RLS design.

`20260924_razorpay_payment_gate.sql` is intentionally a superseded marker and must **not** be applied as a second payment schema.

The final migration is designed to be non-destructive and safe to re-run. It does not drop the Supabase Realtime publication; it only adds the UI-required tables if they are not already published.

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
