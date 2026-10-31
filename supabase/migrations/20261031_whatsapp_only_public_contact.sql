-- Public contact is restricted to a single WhatsApp click-to-chat link.
-- Legacy phone, Telegram and email values remain stored but are no longer exposed publicly.
ALTER TABLE public.site_public_settings
  ADD COLUMN IF NOT EXISTS whatsapp_url text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'site_public_settings_whatsapp_url_format'
      AND conrelid = 'public.site_public_settings'::regclass
  ) THEN
    ALTER TABLE public.site_public_settings
      ADD CONSTRAINT site_public_settings_whatsapp_url_format
      CHECK (whatsapp_url = '' OR whatsapp_url ~ '^https://wa[.]me/[0-9]{7,15}$');
  END IF;
END
$$;

COMMENT ON COLUMN public.site_public_settings.whatsapp_url IS
  'Optional public WhatsApp click-to-chat URL; no phone, Telegram or email contact is exposed publicly.';
