-- Optional diagnostics preserve all existing v1/v2 events and terminal uniqueness.
ALTER FUNCTION analytics_payload_v2_valid(text,jsonb) RENAME TO analytics_payload_v2_base_valid;
CREATE FUNCTION analytics_payload_v2_valid(kind text,p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE extras text[] := ARRAY['readMs','decodeMs','engineMs','cacheHits','cacheMisses','cancelLatencyMs','timeToCancelMs']; k text; v numeric;
BEGIN
 IF NOT analytics_payload_v2_base_valid(kind,p-extras) THEN RETURN false; END IF;
 IF p ?| extras THEN
  IF kind NOT IN ('search_completed','search_cancelled','search_failed') THEN RETURN false; END IF;
  FOREACH k IN ARRAY extras LOOP
   IF p ? k THEN
    IF jsonb_typeof(p->k)<>'number' THEN RETURN false; END IF;
    v:=(p->>k)::numeric;
    IF v<0 OR v<>trunc(v) OR v>(CASE WHEN k IN ('cacheHits','cacheMisses') THEN 1000000 ELSE 86400000 END) THEN RETURN false; END IF;
   END IF;
  END LOOP;
  IF (p ? 'cacheHits') <> (p ? 'cacheMisses') THEN RETURN false; END IF;
  IF (p->>'cacheHits')::numeric+(p->>'cacheMisses')::numeric>(p->>'photosProcessed')::numeric THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- The original CHECK keeps its function OID after renaming. Rebind it to the wrapper.
ALTER TABLE analytics_events DROP CONSTRAINT analytics_payload_versioned;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_payload_versioned CHECK(
 (schema_version=1 AND platform IS NULL AND app_version IS NULL AND type NOT IN('search_interrupted','results_presented') AND analytics_payload_valid(type,payload)) OR
 (schema_version=2 AND platform IS NOT NULL AND platform IN('android','ios') AND app_version IS NOT NULL AND app_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}\+\d{1,10}$' AND analytics_payload_v2_valid(type,payload))
);
