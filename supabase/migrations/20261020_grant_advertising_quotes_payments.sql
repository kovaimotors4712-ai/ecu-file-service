-- These tables are server-only. No browser role can read or mutate quote/payment data.
revoke all on table public.advertising_quotes from public, anon, authenticated;
revoke all on table public.advertising_payments from public, anon, authenticated;
revoke all on table public.advertising_payment_audit from public, anon, authenticated;

grant select, insert, update on table public.advertising_quotes to service_role;
grant select, insert, update on table public.advertising_payments to service_role;
grant select, insert on table public.advertising_payment_audit to service_role;
grant usage, select on sequence public.advertising_payment_audit_id_seq to service_role;
