-- ECU SOLUTION Forum core: additive only. Review and apply only to the verified production project.
-- Public reads are limited to visible content. Publishing/moderation writes require auth + RLS.
BEGIN;

CREATE TABLE public.forum_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.forum_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 32 AND display_name !~ '[[:cntrl:]]'),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 240 AND bio !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX forum_profiles_display_name_ci_uq ON public.forum_profiles (lower(btrim(display_name)));

CREATE TABLE public.forum_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.forum_categories(id) ON DELETE RESTRICT,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 8 AND 160 AND title !~ '[[:cntrl:]]'),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 20 AND 12000),
  is_pinned boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,
  is_hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forum_topics_visible_sort_idx ON public.forum_topics (is_pinned DESC, created_at DESC) WHERE is_hidden = false;
CREATE INDEX forum_topics_category_sort_idx ON public.forum_topics (category_id, created_at DESC) WHERE is_hidden = false;
CREATE INDEX forum_topics_author_idx ON public.forum_topics (author_id, created_at DESC);

CREATE TABLE public.forum_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES public.forum_topics(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 2 AND 8000),
  is_hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forum_replies_topic_sort_idx ON public.forum_replies (topic_id, created_at ASC) WHERE is_hidden = false;
CREATE INDEX forum_replies_author_idx ON public.forum_replies (author_id, created_at DESC);

CREATE TABLE public.forum_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  topic_id uuid REFERENCES public.forum_topics(id) ON DELETE CASCADE,
  reply_id uuid REFERENCES public.forum_replies(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  CONSTRAINT forum_reports_exactly_one_target CHECK ((topic_id IS NOT NULL) <> (reply_id IS NOT NULL))
);
CREATE INDEX forum_reports_open_sort_idx ON public.forum_reports (created_at ASC) WHERE status = 'open';
CREATE UNIQUE INDEX forum_reports_one_topic_per_reporter_uq ON public.forum_reports (reporter_id, topic_id) WHERE topic_id IS NOT NULL;
CREATE UNIQUE INDEX forum_reports_one_reply_per_reporter_uq ON public.forum_reports (reporter_id, reply_id) WHERE reply_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.forum_is_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin', 'moderator'), false);
$$;
REVOKE ALL ON FUNCTION public.forum_is_moderator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forum_is_moderator() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.forum_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.forum_touch_updated_at() FROM PUBLIC;

CREATE TRIGGER forum_profiles_touch_updated_at
BEFORE UPDATE ON public.forum_profiles
FOR EACH ROW EXECUTE FUNCTION public.forum_touch_updated_at();
CREATE TRIGGER forum_topics_touch_updated_at
BEFORE UPDATE ON public.forum_topics
FOR EACH ROW EXECUTE FUNCTION public.forum_touch_updated_at();
CREATE TRIGGER forum_replies_touch_updated_at
BEFORE UPDATE ON public.forum_replies
FOR EACH ROW EXECUTE FUNCTION public.forum_touch_updated_at();

-- Server-side database rate limits apply even if a client bypasses the UI.
CREATE OR REPLACE FUNCTION public.forum_enforce_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid;
  recent_count integer := 0;
BEGIN
  IF TG_TABLE_NAME = 'forum_topics' THEN
    actor := NEW.author_id;
    PERFORM pg_advisory_xact_lock(hashtextextended(actor::text, 0));
    SELECT count(*) INTO recent_count
      FROM public.forum_topics t
      WHERE t.author_id = actor AND t.created_at > now() - interval '10 minutes';
    IF recent_count >= 3 THEN
      RAISE EXCEPTION 'Forum topic rate limit reached. Please wait before posting again.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'forum_replies' THEN
    actor := NEW.author_id;
    PERFORM pg_advisory_xact_lock(hashtextextended(actor::text, 0));
    SELECT count(*) INTO recent_count
      FROM public.forum_replies r
      WHERE r.author_id = actor AND r.created_at > now() - interval '10 minutes';
    IF recent_count >= 12 THEN
      RAISE EXCEPTION 'Forum reply rate limit reached. Please wait before replying again.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'forum_reports' THEN
    actor := NEW.reporter_id;
    PERFORM pg_advisory_xact_lock(hashtextextended(actor::text, 0));
    SELECT count(*) INTO recent_count
      FROM public.forum_reports r
      WHERE r.reporter_id = actor AND r.created_at > now() - interval '1 hour';
    IF recent_count >= 5 THEN
      RAISE EXCEPTION 'Forum report rate limit reached. Please try again later.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.forum_enforce_rate_limit() FROM PUBLIC;

CREATE TRIGGER forum_topics_rate_limit
BEFORE INSERT ON public.forum_topics
FOR EACH ROW EXECUTE FUNCTION public.forum_enforce_rate_limit();
CREATE TRIGGER forum_replies_rate_limit
BEFORE INSERT ON public.forum_replies
FOR EACH ROW EXECUTE FUNCTION public.forum_enforce_rate_limit();
CREATE TRIGGER forum_reports_rate_limit
BEFORE INSERT ON public.forum_reports
FOR EACH ROW EXECUTE FUNCTION public.forum_enforce_rate_limit();

CREATE OR REPLACE FUNCTION public.forum_validate_report_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_author uuid;
  target_hidden boolean;
BEGIN
  IF NEW.topic_id IS NOT NULL THEN
    SELECT t.author_id, t.is_hidden INTO target_author, target_hidden
      FROM public.forum_topics t WHERE t.id = NEW.topic_id;
  ELSE
    SELECT r.author_id, r.is_hidden INTO target_author, target_hidden
      FROM public.forum_replies r WHERE r.id = NEW.reply_id;
  END IF;

  IF target_author IS NULL OR target_hidden THEN
    RAISE EXCEPTION 'That forum item cannot be reported.' USING ERRCODE = 'P0001';
  END IF;
  IF target_author = NEW.reporter_id THEN
    RAISE EXCEPTION 'You cannot report your own content.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.forum_validate_report_target() FROM PUBLIC;
CREATE TRIGGER forum_reports_validate_target
BEFORE INSERT ON public.forum_reports
FOR EACH ROW EXECUTE FUNCTION public.forum_validate_report_target();

ALTER TABLE public.forum_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY forum_categories_read_active
ON public.forum_categories FOR SELECT TO anon, authenticated
USING (is_active OR public.forum_is_moderator());

CREATE POLICY forum_profiles_read_public
ON public.forum_profiles FOR SELECT TO anon, authenticated
USING (true);
CREATE POLICY forum_profiles_insert_owner
ON public.forum_profiles FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY forum_profiles_update_owner
ON public.forum_profiles FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY forum_topics_read_visible
ON public.forum_topics FOR SELECT TO anon, authenticated
USING (NOT is_hidden OR author_id = (SELECT auth.uid()) OR public.forum_is_moderator());
CREATE POLICY forum_topics_insert_owner
ON public.forum_topics FOR INSERT TO authenticated
WITH CHECK (
  author_id = (SELECT auth.uid())
  AND is_hidden = false AND is_pinned = false AND is_locked = false
  AND EXISTS (SELECT 1 FROM public.forum_categories c WHERE c.id = category_id AND c.is_active = true)
);
CREATE POLICY forum_topics_moderator_update
ON public.forum_topics FOR UPDATE TO authenticated
USING (public.forum_is_moderator())
WITH CHECK (public.forum_is_moderator());

CREATE POLICY forum_replies_read_visible
ON public.forum_replies FOR SELECT TO anon, authenticated
USING (NOT is_hidden OR author_id = (SELECT auth.uid()) OR public.forum_is_moderator());
CREATE POLICY forum_replies_insert_owner
ON public.forum_replies FOR INSERT TO authenticated
WITH CHECK (
  author_id = (SELECT auth.uid())
  AND is_hidden = false
  AND EXISTS (
    SELECT 1 FROM public.forum_topics t
    WHERE t.id = topic_id AND t.is_hidden = false AND t.is_locked = false
  )
);
CREATE POLICY forum_replies_moderator_update
ON public.forum_replies FOR UPDATE TO authenticated
USING (public.forum_is_moderator())
WITH CHECK (public.forum_is_moderator());

CREATE POLICY forum_reports_read_own_or_moderator
ON public.forum_reports FOR SELECT TO authenticated
USING (reporter_id = (SELECT auth.uid()) OR public.forum_is_moderator());
CREATE POLICY forum_reports_insert_owner
ON public.forum_reports FOR INSERT TO authenticated
WITH CHECK (
  reporter_id = (SELECT auth.uid())
  AND ((topic_id IS NOT NULL) <> (reply_id IS NOT NULL))
);
CREATE POLICY forum_reports_moderator_update
ON public.forum_reports FOR UPDATE TO authenticated
USING (public.forum_is_moderator())
WITH CHECK (public.forum_is_moderator());

REVOKE ALL ON TABLE public.forum_categories, public.forum_profiles, public.forum_topics, public.forum_replies, public.forum_reports FROM anon, authenticated;
GRANT SELECT ON TABLE public.forum_categories, public.forum_profiles, public.forum_topics, public.forum_replies TO anon, authenticated;
GRANT INSERT, UPDATE ON TABLE public.forum_profiles TO authenticated;
GRANT INSERT, UPDATE ON TABLE public.forum_topics, public.forum_replies, public.forum_reports TO authenticated;
GRANT SELECT ON TABLE public.forum_reports TO authenticated;

INSERT INTO public.forum_categories (slug, title, description, sort_order) VALUES
  ('general-diagnostics', 'General Diagnostics', 'Evidence-led troubleshooting and workshop process.', 10),
  ('dtc-troubleshooting', 'DTC Troubleshooting', 'Discuss fault codes alongside vehicle context and verified test results.', 20),
  ('ecu-identification', 'ECU Identification', 'Controller families, hardware numbers, software IDs and read-method notes.', 30),
  ('wiring-electrical', 'Wiring & Electrical', 'Circuit testing, connector issues, grounding and electrical diagnosis.', 40),
  ('tools-software', 'Tools & Software', 'Legitimate tooling, supported workflows and software usage questions.', 50),
  ('workshop-safety', 'Workshop Safety', 'Safe procedures for SRS, high voltage, and other safety-critical systems.', 60);

NOTIFY pgrst, 'reload schema';
COMMIT;
