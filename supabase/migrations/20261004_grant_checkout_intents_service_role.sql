-- ECU File Service India
-- Grant necessary table privileges to service_role for durable checkout intents.

grant select, insert, update on public.checkout_intents to service_role;
