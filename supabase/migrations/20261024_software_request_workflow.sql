-- Software catalogue price visibility and request-to-delivery workflow.
BEGIN;
ALTER TABLE public.software_products
  ADD COLUMN IF NOT EXISTS price_visible boolean NOT NULL DEFAULT false;
ALTER TABLE public.forum_customer_requests
  ADD COLUMN IF NOT EXISTS software_product_id uuid REFERENCES public.software_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS software_status text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS quoted_price_paise bigint,
  ADD COLUMN IF NOT EXISTS software_payment_link text,
  ADD COLUMN IF NOT EXISTS software_delivery_url text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.forum_customer_requests'::regclass AND conname='forum_customer_requests_software_status_check') THEN
    ALTER TABLE public.forum_customer_requests ADD CONSTRAINT forum_customer_requests_software_status_check
      CHECK (software_status IN ('not_applicable','requested','in_review','quoted','awaiting_payment','paid','delivered','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.forum_customer_requests'::regclass AND conname='forum_customer_requests_quoted_price_check') THEN
    ALTER TABLE public.forum_customer_requests ADD CONSTRAINT forum_customer_requests_quoted_price_check
      CHECK (quoted_price_paise IS NULL OR quoted_price_paise BETWEEN 0 AND 100000000000);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS forum_customer_requests_software_queue_idx
 ON public.forum_customer_requests(software_status, created_at DESC)
 WHERE request_type='software_requirement';
COMMIT;