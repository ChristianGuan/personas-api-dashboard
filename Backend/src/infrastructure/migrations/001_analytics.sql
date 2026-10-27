CREATE TABLE installations (
 id uuid PRIMARY KEY, token_hash char(64) NOT NULL,
 last_seen timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE event_types (name text PRIMARY KEY);
INSERT INTO event_types VALUES ('session_started'),('session_ended'),('search_started'),('search_completed'),('search_cancelled'),('search_failed'),('results_rated'),('results_reviewed');
CREATE FUNCTION analytics_payload_valid(kind text, p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; n numeric;
BEGIN
 IF jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
 IF kind IN ('session_started','search_started') THEN RETURN p = '{}'::jsonb; END IF;
 IF kind='session_ended' AND NOT (p ?& ARRAY['durationMs'] AND p - 'durationMs' = '{}') THEN RETURN false; END IF;
 IF kind='search_completed' AND NOT (p ?& ARRAY['durationMs','photoRange','matchRange'] AND p - ARRAY['durationMs','photoRange','matchRange'] = '{}') THEN RETURN false; END IF;
 IF kind='search_cancelled' AND NOT (p ?& ARRAY['durationMs','photoRange'] AND p - ARRAY['durationMs','photoRange'] = '{}') THEN RETURN false; END IF;
 IF kind='search_failed' AND NOT (p ?& ARRAY['durationMs','errorCategory'] AND p - ARRAY['durationMs','errorCategory'] = '{}') THEN RETURN false; END IF;
 IF kind='results_rated' AND NOT (p ? 'stars' AND p - 'stars' = '{}') THEN RETURN false; END IF;
 IF kind='results_reviewed' AND NOT (p ?& ARRAY['confirmed','rejected'] AND p - ARRAY['confirmed','rejected'] = '{}') THEN RETURN false; END IF;
 FOR k IN SELECT jsonb_object_keys(p) LOOP
  IF k IN ('durationMs','stars','confirmed','rejected') THEN
   IF jsonb_typeof(p->k) <> 'number' THEN RETURN false; END IF;
   n := (p->>k)::numeric;
   IF n <> trunc(n) OR n < 0 OR n > (CASE k WHEN 'durationMs' THEN 86400000 WHEN 'stars' THEN 5 ELSE 1000000 END) THEN RETURN false; END IF;
   IF k='stars' AND n < 1 THEN RETURN false; END IF;
  ELSIF k IN ('photoRange','matchRange') THEN
   IF jsonb_typeof(p->k) <> 'string' OR NOT (p->>k = ANY(ARRAY['0','1-25','26-100','101-500','501+'])) THEN RETURN false; END IF;
  ELSIF k='errorCategory' THEN
   IF jsonb_typeof(p->k) <> 'string' OR NOT (p->>k = ANY(ARRAY['permission','storage','processing','unknown'])) THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
 END LOOP;
 IF kind='results_reviewed' AND (p->>'confirmed')::numeric + (p->>'rejected')::numeric = 0 THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE analytics_events (
 event_id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES installations(id),
 type text NOT NULL REFERENCES event_types(name), schema_version integer NOT NULL CHECK(schema_version=1),
 created_at timestamptz NOT NULL, payload jsonb NOT NULL,
 CHECK (analytics_payload_valid(type,payload))
);
CREATE INDEX analytics_installation_date ON analytics_events(installation_id,created_at);
CREATE INDEX analytics_type_date ON analytics_events(type,created_at);
CREATE INDEX analytics_date ON analytics_events(created_at);
-- Aggregate dimensions contain no installation/event identifiers. duration = bucket in whole seconds.
CREATE TABLE daily_metrics (
 day date NOT NULL, type text NOT NULL REFERENCES event_types(name),
 dimension text NOT NULL, count bigint NOT NULL, total numeric NOT NULL DEFAULT 0,
 PRIMARY KEY(day,type,dimension)
);
CREATE INDEX installations_retention ON installations(last_seen);
