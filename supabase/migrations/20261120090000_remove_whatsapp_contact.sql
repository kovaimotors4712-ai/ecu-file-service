-- Permanently remove the legacy WhatsApp contact field and retain Telegram only.
ALTER TABLE public.site_public_settings
  ADD COLUMN IF NOT EXISTS telegram_url text NOT NULL DEFAULT '';

-- Preserve only an already-valid Telegram URL; discard any WhatsApp URL/number.
UPDATE public.site_public_settings
SET telegram_url = CASE
  WHEN telegram_url ~ '^https://t\\.me/[A-Za-z0-9_]{5,32}/?$' THEN telegram_url
  ELSE ''
END;

ALTER TABLE public.site_public_settings
  DROP COLUMN IF EXISTS whatsapp_url;

ALTER TABLE public.site_public_settings
  DROP CONSTRAINT IF EXISTS site_public_settings_telegram_url_format;
ALTER TABLE public.site_public_settings
  ADD CONSTRAINT site_public_settings_telegram_url_format
  CHECK (telegram_url = '' OR telegram_url ~ '^https://t\\.me/[A-Za-z0-9_]{5,32}/?$');

COMMENT ON COLUMN public.site_public_settings.telegram_url IS
  'Optional public Telegram link; no phone, WhatsApp or email contact is exposed publicly.';
