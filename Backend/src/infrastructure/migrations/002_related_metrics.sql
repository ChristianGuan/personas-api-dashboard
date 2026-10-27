INSERT INTO event_types VALUES('search_interrupted'),('results_presented');
ALTER TABLE analytics_events RENAME CONSTRAINT analytics_events_check TO analytics_payload_v1_check;
ALTER TABLE analytics_events DROP CONSTRAINT analytics_payload_v1_check;
ALTER TABLE analytics_events DROP CONSTRAINT analytics_events_schema_version_check;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_schema_version CHECK(schema_version IN(1,2));
ALTER TABLE analytics_events ADD COLUMN platform text;
ALTER TABLE analytics_events ADD COLUMN app_version text;
ALTER TABLE analytics_events ADD COLUMN received_at timestamptz;
ALTER TABLE analytics_events ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0 CHECK(delivery_attempts BETWEEN 0 AND 1000000);
-- Existing v1 arrival times are unknown; do not manufacture them.
CREATE FUNCTION analytics_payload_v2_valid(kind text,p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE allowed text[]; k text; v numeric;
BEGIN
 IF jsonb_typeof(p)<>'object' THEN RETURN false; END IF;
 allowed:=CASE kind
 WHEN 'session_started' THEN ARRAY['sessionId']
 WHEN 'session_ended' THEN ARRAY['sessionId','durationMs']
 WHEN 'search_started' THEN ARRAY['sessionId','searchId','photosPlanned']
 WHEN 'search_completed' THEN ARRAY['sessionId','searchId','photosPlanned','photosProcessed','unreadableCount','matchesShown','timingSource','durationMs','setupMs','processingMs']
 WHEN 'search_cancelled' THEN ARRAY['sessionId','searchId','photosPlanned','photosProcessed','unreadableCount','matchesShown','timingSource','durationMs','setupMs','processingMs']
 WHEN 'search_failed' THEN ARRAY['sessionId','searchId','photosPlanned','photosProcessed','unreadableCount','matchesShown','timingSource','durationMs','setupMs','processingMs','errorCategory']
 WHEN 'search_interrupted' THEN ARRAY['sessionId','searchId','photosPlanned','errorCategory']
 WHEN 'results_rated' THEN ARRAY['sessionId','searchId','stars']
 WHEN 'results_reviewed' THEN ARRAY['sessionId','searchId','confirmed','rejected']
 WHEN 'results_presented' THEN ARRAY['sessionId','searchId','presentationMs'] ELSE NULL END;
 IF kind IN('search_completed','search_cancelled','search_failed') AND p->>'timingSource'='unavailable' THEN allowed:=array_remove(array_remove(array_remove(allowed,'durationMs'),'setupMs'),'processingMs'); END IF;
 IF allowed IS NULL OR NOT(p ?& allowed) OR p-allowed<>'{}' THEN RETURN false; END IF;
 FOR k IN SELECT jsonb_object_keys(p) LOOP
  IF k IN('sessionId','searchId') THEN
   IF jsonb_typeof(p->k)<>'string' OR NOT(p->>k ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  ELSIF k='timingSource' THEN
   IF jsonb_typeof(p->k)<>'string' OR NOT(p->>k=ANY(ARRAY['live','unavailable'])) THEN RETURN false; END IF;
  ELSIF k='errorCategory' THEN
   IF jsonb_typeof(p->k)<>'string' THEN RETURN false; END IF;
   IF kind='search_interrupted' THEN
    IF p->>k<>'process_interrupted' THEN RETURN false; END IF;
   ELSIF NOT(p->>k=ANY(ARRAY['permission','storage','processing','unknown'])) THEN RETURN false;
   END IF;
  ELSE
   IF jsonb_typeof(p->k)<>'number' THEN RETURN false; END IF;
   v:=(p->>k)::numeric;
   IF v<0 OR v<>trunc(v) OR v>(CASE WHEN k IN('durationMs','setupMs','processingMs','presentationMs') THEN 86400000 WHEN k='stars' THEN 5 ELSE 1000000 END) THEN RETURN false; END IF;
   IF k='stars' AND v<1 THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF kind IN('search_completed','search_cancelled','search_failed') THEN
  IF (p->>'photosProcessed')::numeric>(p->>'photosPlanned')::numeric OR (p->>'unreadableCount')::numeric+(p->>'matchesShown')::numeric>(p->>'photosProcessed')::numeric OR (p->>'setupMs')::numeric+(p->>'processingMs')::numeric>(p->>'durationMs')::numeric THEN RETURN false; END IF;
 END IF;
 IF kind='results_reviewed' AND (p->>'confirmed')::numeric+(p->>'rejected')::numeric=0 THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE analytics_events ADD CONSTRAINT analytics_payload_versioned CHECK(
 (schema_version=1 AND platform IS NULL AND app_version IS NULL AND type NOT IN('search_interrupted','results_presented') AND analytics_payload_valid(type,payload)) OR
 (schema_version=2 AND platform IS NOT NULL AND platform IN('android','ios') AND app_version IS NOT NULL AND app_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}\+\d{1,10}$' AND analytics_payload_v2_valid(type,payload))
);
CREATE UNIQUE INDEX analytics_search_once ON analytics_events(installation_id,(payload->>'searchId'),(CASE WHEN type IN('search_completed','search_cancelled','search_failed','search_interrupted') THEN 'terminal' ELSE type END)) WHERE schema_version=2 AND payload ? 'searchId';
CREATE UNIQUE INDEX analytics_session_once ON analytics_events(installation_id,(payload->>'sessionId'),type) WHERE schema_version=2 AND type IN('session_started','session_ended');
CREATE INDEX analytics_platform_version_date ON analytics_events(platform,app_version,created_at) WHERE schema_version=2;
CREATE INDEX analytics_search_lookup ON analytics_events(installation_id,(payload->>'searchId')) WHERE schema_version=2;
