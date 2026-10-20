-- Narrow permission repair for the asynchronous notification delivery worker.
-- Apply only after confirming this is the production project and reviewing migration history.
-- SELECT allows the worker to read queued events; UPDATE allows it to mark delivery state.
GRANT SELECT, UPDATE ON TABLE public.notification_outbox TO service_role;
