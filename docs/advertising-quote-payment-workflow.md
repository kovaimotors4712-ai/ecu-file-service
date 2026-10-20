# Advertising quotation and payment workflow

## Release status

The quote/payment code is deployed to production and the Supabase schema is applied. The public advertiser form remains enquiry-only until an administrator creates and issues a quote. CI passed 78/78 tests, and live smoke checks confirmed health/configuration plus expected access-control responses. A real Razorpay Test Mode transaction has not yet been completed end-to-end, so treat the payment workflow as deployed but awaiting final transaction verification.

## Implemented and deployed

- Admin can review advertising enquiries, create an INR quote draft, choose a placement and date window, record expiry and written terms, and issue/decline the quote.
- Issuing generates a 256-bit one-time token; only its SHA-256 digest is stored. The token is sent in the URL fragment so it is not sent in HTTP requests or normal referrer headers. The quote page removes the fragment from the address bar before making API calls and is marked noindex/nofollow.
- Public quote endpoints support viewing and accepting a valid quote.
- Razorpay order creation reads the amount from the persisted quote, uses integer paise, records the provider order, and binds the quote/payment row IDs in provider notes.
- Verification checks the Razorpay signature server-side, independently fetches the provider order and payment, checks the quote/payment IDs, captured status, exact amount and INR currency, and calls an atomic database finalizer.
- Payment reconciliation is available for a checkout callback/network interruption; the customer is instructed not to pay again while payment is being checked.
- Admin publication links an advertisement to its exact paid quote. Database constraints and a trigger require a verified paid quote whose placement and schedule match the advertisement.
- Quote/payment/audit tables have RLS enabled and browser-role access revoked. The database lifecycle triggers prevent changing issued quote snapshots and invalid payment/quote transitions.
- Stale payment-order reservations can be marked failed after a recovery window when no provider order was saved, allowing safe retry without leaving the quote permanently locked.
- Existing ECU-file checkout tables, payment flow and customer order model remain separate.

## Data model and lifecycle

The feature uses separate `advertising_quotes`, `advertising_payments`, and `advertising_payment_audit` tables. It does not reuse ECU `orders` or `checkout_intents`.

Quote lifecycle:
`draft → issued → accepted → payment_pending → paid`

Declined, expired, cancelled, and payment-failed states are represented explicitly. Once issued, the price, placement, dates, expiry and written terms are immutable; changes require a new quote version. Amounts are integer paise in INR.

Payment lifecycle includes a reserved `creating` attempt, a saved Razorpay order, and server-verified payment finalization. The database finalizer locks quote and payment rows, validates their matching amount/currency/order references, and is idempotent for the same verified payment.

## Security and release gates

- No browser-provided amount is trusted for payment creation.
- A browser callback alone is not proof of payment; Razorpay API confirmation and HMAC signature validation are required.
- Service-role credentials and payment secrets remain server-only.
- A paid quote does not itself publish content. Creative approval/publication is a separate admin action and requires a matching paid quote.
- Payment and publication states remain separate; ads are not automatically published after payment.
- Do not invent advertising rates, GST/tax treatment, refund/cancellation policy, ad guarantees, or legal terms. Admin must enter the terms actually agreed with the advertiser.
- Verify that all migrations run in order and confirm RLS/grants/trigger behavior in the target Supabase project before enabling endpoints in production.
- Required validation before release: passing GitHub Actions tests, syntax/security checks, Razorpay Test Mode create-order/signature/capture/reconciliation tests, successful and failed email delivery tests, expired quote and concurrent attempt checks, and an end-to-end publication guard test.
- Do not use a real payment during verification. Do not alter the existing ECU-file checkout or expose private ECU files.
