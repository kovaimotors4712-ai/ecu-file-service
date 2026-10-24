-- Persist Razorpay's server-issued payment-link id for software payment verification.
alter table public.forum_customer_requests
  add column if not exists software_payment_link_id text;

alter table public.forum_customer_requests
  drop constraint if exists forum_customer_requests_software_payment_link_id_check;
alter table public.forum_customer_requests
  add constraint forum_customer_requests_software_payment_link_id_check
  check (
    software_payment_link_id is null
    or software_payment_link_id ~ '^plink_[A-Za-z0-9]+$'
  );
