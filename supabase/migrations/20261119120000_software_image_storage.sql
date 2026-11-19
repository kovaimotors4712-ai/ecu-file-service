-- Dedicated public storage for software catalogue images.
-- Public visitors may view image URLs; only authenticated admins may upload.
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'software-images',
  'software-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/avif']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Admins upload software images" ON storage.objects;
CREATE POLICY "Admins upload software images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'software-images'
  AND public.is_admin()
);

COMMIT;
