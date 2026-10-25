-- Shared second-stage payment fields for non-software customer requirements.
-- The existing software_* fields remain intact, and the ₹99 ECU file checkout is untouched.
alter table public.forum_customer_requests
  add column if not exists request_quote_amount_paise integer,
  add column if not exists request_payment_link text,
  add column if not exists request_payment_link_id text,
  add column if not exists request_payment_status text not null default 'not_required',
  add column if not exists request_delivery_path text,
  add column if not exists request_delivery_name text;

alter table public.forum_customer_requests
  drop constraint if exists forum_customer_requests_request_quote_amount_check;
alter table public.forum_customer_requests
  add constraint forum_customer_requests_request_quote_amount_check
  check (request_quote_amount_paise is null or request_quote_amount_paise > 0);

alter table public.forum_customer_requests
  drop constraint if exists forum_customer_requests_request_payment_status_check;
alter table public.forum_customer_requests
  add constraint forum_customer_requests_request_payment_status_check
  check (request_payment_status in ('not_required','pending','paid'));

alter table public.forum_customer_requests
  drop constraint if exists forum_customer_requests_request_payment_link_id_check;
alter table public.forum_customer_requests
  add constraint forum_customer_requests_request_payment_link_id_check
  check (request_payment_link_id is null or request_payment_link_id ~ '^plink_[A-Za-z0-9]+$');

alter table public.forum_customer_requests
  drop constraint if exists forum_customer_requests_request_delivery_path_check;
alter table public.forum_customer_requests
  add constraint forum_customer_requests_request_delivery_path_check
  check (request_delivery_path is null or (request_delivery_path like 'requirement-deliveries/%' and position('..' in request_delivery_path)=0 and position(chr(92) in request_delivery_path)=0));
