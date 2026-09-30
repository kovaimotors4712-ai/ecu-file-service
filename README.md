# ECU FILE SERVICE INDIA

A responsive customer storefront and admin console for ECU, airbag and dashboard file requests.

## Run locally

Use Node.js 18 or newer. In PowerShell, from `F:\web`, run:

```powershell
npm start
```

Open <http://127.0.0.1:4173>. The checkout library is loaded from Razorpay when the page opens; an internet connection is required for Checkout.
Run the local HTTP security and readiness checks with `npm test`. There is no frontend build step or third-party Node dependency in this architecture.

For UI-only checkout testing before the Supabase payment migration is confirmed, start a development-only Test Mode server. In PowerShell:

```powershell
$env:NODE_ENV = 'development'
npm run checkout:test
```

This explicit local bypass activates the checkout UI only with Razorpay Test Mode credentials. It does not bypass Supabase authentication or the paid-order RPC, so a simulated successful payment cannot create/store an order until the payment migration and policies are installed. Never set `NODE_ENV=development` or enable the bypass on a deployed server. Rotate any credentials previously exposed in terminal/tool output before testing.

## Customer payment and file flow

1. The customer signs in, completes the vehicle/service steps and selects an original file (up to 50 MB).
2. The server reads the configured verification price, creates a Razorpay order using server-only API credentials, and records a short-lived/private local payment-state record binding that Razorpay order to the signed-in customer and a hash of the request/file.
3. Razorpay Checkout opens using the server-created order and the public Razorpay Key ID.
4. After Checkout returns, the server verifies the HMAC signature with the locally configured Key Secret and independently fetches the Razorpay payment. It requires the matching Razorpay order, exact amount/currency, and `captured` state.
5. Only then does the server sign a short-lived payment proof and call the restricted `efsi_create_paid_order` database function with the customer's Supabase access token. The function verifies the proof against Supabase Vault before marking the order paid. The server then registers and uploads the original file using that same customer token.

The order has typed payment columns and its notes retain a fee snapshot and signed payment reference. The admin console verifies the proof before displaying a payment as PAID. Failed, dismissed, mismatched or uncaptured payments do not create orders or upload files. If payment is captured but a later Supabase operation temporarily fails, the customer can retry completion without paying again while the Checkout response and original file remain available in the page.

**Do not enable checkout yet.** The existing Supabase customer RLS policies still allow a signed-in customer to insert an order and upload an original file directly, outside the website payment flow. Server checks cannot stop a user from calling Supabase directly under those policies. The proposed additive migration at `supabase/migrations/20260924_razorpay_payment_gate.sql` closes that bypass and adds a paid-order RPC. It is prepared locally but has not been run. Keep `PAYMENT_GATE_SCHEMA_READY=false` until that migration and its Vault secret are applied and verified. No Supabase schema or RLS was changed by this task.

The local payment-state directory defaults to the operating system's temporary directory. For deployment, set `PAYMENT_STATE_DIR` to a private, persistent directory writable only by the server and outside the web root. Do not serve that directory publicly. Back it up and define a retention/cleanup policy. The server uses no service-role key and currently accepts Razorpay Test Mode credentials only; Live Mode is not supported.

## Local configuration

Copy `.env.example` to `.env` if needed. Enter the values directly in `F:\web\.env` using a local editor. Start with Razorpay **Test Mode** credentials:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=your_test_key_secret
PAYMENT_GATE_PROOF_SECRET=your_separate_random_proof_secret
PAYMENT_GATE_SCHEMA_READY=false
PORT=4173
```

Replace the examples locally with the Supabase project URL/public anon key and Razorpay Test Mode Key ID/Key Secret from the respective dashboards. Generate a separate random `PAYMENT_GATE_PROOF_SECRET` locally; enter it only in `.env` and Supabase Vault as `efsi_payment_gate_proof_secret`. Never add either secret to HTML, browser JavaScript, source control, or chat. Do not use a Supabase service-role/secret key. The Key ID is returned at runtime to Razorpay Checkout as required by Razorpay; the Key Secret and proof secret remain server-side.

Restart `npm start` after changing `.env`. Keep `PAYMENT_GATE_SCHEMA_READY=false` until the required Supabase payment-gate/RLS change is reviewed, applied, and verified. This code is locked to Test Mode; do not use real payment credentials or accept live payments with this version.

## Supabase

The site uses Supabase Auth, PostgREST and private Storage through a same-origin Node proxy. It accepts only the public anon/publishable key and forwards the signed-in customer's access token. The proposed payment migration requires Supabase Vault, adds payment columns, removes direct customer order insertion, restricts original-file insertion/storage upload to paid orders, and adds an authenticated HMAC-verified paid-order RPC. Applying it changes the database and requires review/approval. Store the separate `PAYMENT_GATE_PROOF_SECRET` value in Supabase Vault under `efsi_payment_gate_proof_secret`; do this in the Dashboard, never in this repo or chat. The Razorpay Key Secret stays out of Supabase.

To administer orders, set trusted `app_metadata.role` to `admin` for the chosen Supabase Auth user in the Dashboard, then sign in at `/admin.html`. The database status workflow remains **New → File Review → Processing → Completed**; processed files remain in the private bucket.

## Payment implementation notes

- Razorpay calls are made server-side over HTTPS with HTTP Basic authentication. The server returns only the Key ID and Razorpay order details needed by Checkout.
- Signature verification follows [Razorpay's Standard Checkout integration guidance](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/).
- The migration adds typed payment fields to `orders`; notes preserve a readable fee snapshot and payment proof for the admin view. The database RPC accepts only a server proof tied to the customer, order, payment references, amount, and request hash.
- The current completion callback supports an in-page retry after an immediate server/storage failure. Durable recovery after a closed browser or lost callback requires a persistent payment intent/file staging design plus a Razorpay webhook and a trusted database fulfillment path.
- No payment secrets are stored in this repository. `.env` and local pricing/payment-state files are ignored by Git.

## Deployment

The existing architecture is a single Node HTTP server that serves the public frontend and same-origin API. Deploy it behind a TLS-terminating reverse proxy or a Node host that provides HTTPS and persistent private storage for `PAYMENT_STATE_DIR`. The server binds to `127.0.0.1`; a reverse proxy must run on the same host, or deployment networking must be deliberately configured. Set the public domain before adding canonical URLs and an absolute sitemap; neither is included because the production hostname is not known.
