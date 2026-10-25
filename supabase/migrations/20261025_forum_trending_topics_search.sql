-- Frequency-based automotive forum topics and broad related-discussion search.
-- Promote only recurring automotive terms: >=3 messages from >=2 distinct members in the last 30 days.
BEGIN;

ALTER TABLE public.forum_topics
  ADD COLUMN IF NOT EXISTS auto_topic_key text;

CREATE UNIQUE INDEX IF NOT EXISTS forum_topics_auto_topic_key_uidx
  ON public.forum_topics(auto_topic_key)
  WHERE auto_topic_key IS NOT NULL;

ALTER TABLE public.forum_topics
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED;

CREATE INDEX IF NOT EXISTS forum_topics_search_vector_idx
  ON public.forum_topics USING gin(search_vector)
  WHERE is_hidden = false;

CREATE TABLE IF NOT EXISTS public.forum_auto_topic_signals (
  topic_key text PRIMARY KEY CHECK (topic_key ~ '^[a-z0-9-]{2,60}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  category_id uuid REFERENCES public.forum_categories(id) ON DELETE SET NULL,
  mention_count integer NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  distinct_members integer NOT NULL DEFAULT 0 CHECK (distinct_members >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.forum_auto_topic_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.forum_auto_topic_signals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.forum_auto_topic_signals TO anon, authenticated;
DROP POLICY IF EXISTS forum_auto_topic_signals_read ON public.forum_auto_topic_signals;
CREATE POLICY forum_auto_topic_signals_read ON public.forum_auto_topic_signals
  FOR SELECT TO anon, authenticated USING (promoted_at IS NOT NULL);

-- Keyword dictionary is deliberately controlled; greetings and generic chat never become topics.
CREATE OR REPLACE FUNCTION public.forum_classify_chat_terms(p_body text)
RETURNS TABLE(topic_key text, label text)
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT d.topic_key, d.label
  FROM (VALUES
    ('maruti','Maruti Suzuki'), ('suzuki','Maruti Suzuki'),
    ('hyundai','Hyundai'), ('tata','Tata Motors'), ('mahindra','Mahindra'),
    ('toyota','Toyota'), ('honda','Honda'), ('ford','Ford'),
    ('volkswagen','Volkswagen'), ('fiat','Fiat'),
    ('fuel-pump','Fuel Pump'), ('injector','Fuel Injectors'),
    ('turbo','Turbocharger'), ('egr','EGR System'), ('dpf','DPF / Particulate Filter'),
    ('abs','ABS System'), ('airbag','Airbag / SRS'), ('crank-sensor','Crankshaft Sensor'),
    ('cam-sensor','Camshaft Sensor'), ('accelerator-pedal','Accelerator Pedal Sensor'),
    ('wiring','Wiring & Electrical'), ('edc16','Bosch EDC16 ECU'), ('edc17','Bosch EDC17 ECU'),
    ('md1','MD1 ECU'), ('dcm','DCM ECU'), ('bosch','Bosch ECU'), ('denso','Denso ECU')
  ) AS d(topic_key, label)
  WHERE coalesce(p_body,'') ~* (
    CASE d.topic_key
      WHEN 'fuel-pump' THEN '\mfuel[[:space:]-]*pump\M'
      WHEN 'crank-sensor' THEN '\mcrank([[:space:]-]*shaft)?[[:space:]-]*sensor\M'
      WHEN 'cam-sensor' THEN '\mcam([[:space:]-]*shaft)?[[:space:]-]*sensor\M'
      WHEN 'accelerator-pedal' THEN '\maccelerator[[:space:]-]*pedal\M'
      WHEN 'edc16' THEN '\medc[[:space:]]*16\w*\M'
      WHEN 'edc17' THEN '\medc[[:space:]]*17\w*\M'
      WHEN 'md1' THEN '\mmd1\w*\M'
      WHEN 'dcm' THEN '\mdcm[[:space:]]*[0-9.]*\M'
      ELSE '\m' || d.topic_key || '\M'
    END
  );
$$;
REVOKE ALL ON FUNCTION public.forum_classify_chat_terms(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forum_classify_chat_terms(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.forum_promote_chat_terms()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  term record;
  total_mentions integer;
  member_count integer;
  cat_id uuid;
  sample_messages text;
  topic_title text;
BEGIN
  IF NEW.body IS NULL OR char_length(btrim(NEW.body)) < 12 THEN
    RETURN NEW;
  END IF;

  FOR term IN SELECT * FROM public.forum_classify_chat_terms(NEW.body) LOOP
    INSERT INTO public.forum_auto_topic_signals(topic_key,label,last_seen_at)
    VALUES(term.topic_key,term.label,NEW.created_at)
    ON CONFLICT(topic_key) DO UPDATE SET last_seen_at = GREATEST(public.forum_auto_topic_signals.last_seen_at, EXCLUDED.last_seen_at);

    SELECT count(*), count(DISTINCT author_id)
      INTO total_mentions, member_count
      FROM public.forum_chat_messages m
      WHERE m.created_at >= now() - interval '30 days'
        AND m.body ~* (
          CASE term.topic_key
            WHEN 'fuel-pump' THEN '\mfuel[[:space:]-]*pump\M'
            WHEN 'crank-sensor' THEN '\mcrank([[:space:]-]*shaft)?[[:space:]-]*sensor\M'
            WHEN 'cam-sensor' THEN '\mcam([[:space:]-]*shaft)?[[:space:]-]*sensor\M'
            WHEN 'accelerator-pedal' THEN '\maccelerator[[:space:]-]*pedal\M'
            WHEN 'edc16' THEN '\medc[[:space:]]*16\w*\M'
            WHEN 'edc17' THEN '\medc[[:space:]]*17\w*\M'
            WHEN 'md1' THEN '\mmd1\w*\M'
            WHEN 'dcm' THEN '\mdcm[[:space:]]*[0-9.]*\M'
            ELSE '\m' || term.topic_key || '\M'
          END
        );

    UPDATE public.forum_auto_topic_signals
      SET mention_count = total_mentions, distinct_members = member_count
      WHERE topic_key = term.topic_key;

    IF total_mentions >= 3 AND member_count >= 2 THEN
      SELECT id INTO cat_id FROM public.forum_categories WHERE slug = ('auto-' || term.topic_key) LIMIT 1;
      IF cat_id IS NULL THEN
        INSERT INTO public.forum_categories(slug,title,description,sort_order,is_active)
        VALUES('auto-' || term.topic_key, term.label,
          'Automatically promoted from recurring workshop chat discussions in the last 30 days. Search this section for related vehicle, ECU, symptom and diagnostic-code discussions.',
          1000, true)
        ON CONFLICT(slug) DO UPDATE SET is_active = true
        RETURNING id INTO cat_id;
      END IF;

      SELECT string_agg(format('• %s: %s', left(m.created_at::text,16), left(m.body,500)), E'\n\n' ORDER BY m.created_at DESC)
        INTO sample_messages
        FROM (
          SELECT created_at, body FROM public.forum_chat_messages m
          WHERE m.created_at >= now() - interval '30 days'
            AND m.body ~* (
              CASE term.topic_key
                WHEN 'fuel-pump' THEN '\mfuel[[:space:]-]*pump\M'
                WHEN 'crank-sensor' THEN '\mcrank([[:space:]-]*shaft)?[[:space:]-]*sensor\M'
                WHEN 'cam-sensor' THEN '\mcam([[:space:]-]*shaft)?[[:space:]-]*sensor\M'
                WHEN 'accelerator-pedal' THEN '\maccelerator[[:space:]-]*pedal\M'
                WHEN 'edc16' THEN '\medc[[:space:]]*16\w*\M'
                WHEN 'edc17' THEN '\medc[[:space:]]*17\w*\M'
                WHEN 'md1' THEN '\mmd1\w*\M'
                WHEN 'dcm' THEN '\mdcm[[:space:]]*[0-9.]*\M'
                ELSE '\m' || term.topic_key || '\M'
              END
            )
          ORDER BY created_at DESC LIMIT 8
        ) m;

      topic_title := term.label || ' — recurring workshop discussions';
      INSERT INTO public.forum_topics(category_id,author_id,title,body,source_chat_message_id,auto_topic_key)
      VALUES(cat_id,NEW.author_id,topic_title,
        'Automatically grouped from recurring public workshop chat messages. This is a topic index, not a verified repair procedure. Confirm vehicle model/year, engine, ECU identifiers, DTCs and test evidence before acting.' || E'\n\n' || coalesce(sample_messages,''),
        NEW.id,term.topic_key)
      ON CONFLICT (auto_topic_key) WHERE auto_topic_key IS NOT NULL
      DO UPDATE SET body = EXCLUDED.body, category_id = EXCLUDED.category_id, updated_at = now();

      UPDATE public.forum_auto_topic_signals SET category_id = cat_id, promoted_at = coalesce(promoted_at, now())
      WHERE topic_key = term.topic_key;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.forum_promote_chat_terms() FROM PUBLIC;
DROP TRIGGER IF EXISTS forum_chat_promote_recurring_terms ON public.forum_chat_messages;
CREATE TRIGGER forum_chat_promote_recurring_terms
AFTER INSERT ON public.forum_chat_messages
FOR EACH ROW EXECUTE FUNCTION public.forum_promote_chat_terms();

CREATE OR REPLACE FUNCTION public.forum_search_topics(p_query text, p_limit integer DEFAULT 100)
RETURNS TABLE(id uuid, category_id uuid, author_id uuid, title text, body text,
  is_pinned boolean, is_locked boolean, accepted_reply_id uuid, created_at timestamptz,
  match_rank real)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  q text := btrim(coalesce(p_query,''));
BEGIN
  IF char_length(q) < 2 OR char_length(q) > 120 THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT t.id,t.category_id,t.author_id,t.title,t.body,t.is_pinned,t.is_locked,
      t.accepted_reply_id,t.created_at,
      ts_rank(t.search_vector, websearch_to_tsquery('simple', q)) AS match_rank
    FROM public.forum_topics t
    WHERE NOT t.is_hidden
      AND (t.search_vector @@ websearch_to_tsquery('simple', q)
        OR t.title ILIKE '%' || q || '%'
        OR t.body ILIKE '%' || q || '%')
    ORDER BY match_rank DESC,t.is_pinned DESC,t.created_at DESC
    LIMIT greatest(1,least(coalesce(p_limit,100),100));
END;
$$;
REVOKE ALL ON FUNCTION public.forum_search_topics(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forum_search_topics(text,integer) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
