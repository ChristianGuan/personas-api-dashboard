import {Pool} from 'pg';
export async function relatedMetrics(pool:Pool,from:Date,to:Date) {
 const {rows}=await pool.query(`WITH all_v2 AS (SELECT * FROM analytics_events WHERE schema_version=2),
 window_events AS (SELECT * FROM all_v2 WHERE created_at >= $1 AND created_at < $2),
 starts AS (SELECT * FROM window_events WHERE type='search_started'),
 cohort AS (
  SELECT s.installation_id,s.payload->>'searchId' search_id,s.platform,s.app_version,
   t.type terminal_type,t.payload terminal,r.payload rating,v.payload review,p.payload presentation
  FROM starts s
  LEFT JOIN all_v2 t ON t.installation_id=s.installation_id AND t.payload->>'searchId'=s.payload->>'searchId' AND t.type IN('search_completed','search_cancelled','search_failed','search_interrupted')
  LEFT JOIN all_v2 r ON r.installation_id=s.installation_id AND r.payload->>'searchId'=s.payload->>'searchId' AND r.type='results_rated'
  LEFT JOIN all_v2 v ON v.installation_id=s.installation_id AND v.payload->>'searchId'=s.payload->>'searchId' AND v.type='results_reviewed'
  LEFT JOIN all_v2 p ON p.installation_id=s.installation_id AND p.payload->>'searchId'=s.payload->>'searchId' AND p.type='results_presented'
 ), totals AS (
 SELECT count(*)::int searches_started,count(*) FILTER(WHERE terminal_type='search_completed')::int searches_completed,
 count(*) FILTER(WHERE terminal_type='search_cancelled')::int searches_cancelled,
 count(*) FILTER(WHERE terminal_type='search_failed')::int searches_failed,
 count(*) FILTER(WHERE terminal_type='search_interrupted')::int searches_interrupted,
 count(*) FILTER(WHERE terminal_type IS NULL)::int without_observed_end,
 count(*) FILTER(WHERE terminal_type='search_completed' AND terminal ? 'durationMs')::int completed_timing_samples,
 count(*) FILTER(WHERE terminal_type='search_completed' AND rating IS NOT NULL)::int rated_completions,
 count(*) FILTER(WHERE terminal_type='search_completed' AND review IS NOT NULL)::int reviewed_completions,
 sum((terminal->>'photosPlanned')::float) photos_planned,sum((terminal->>'photosProcessed')::float) photos_processed,
 sum((terminal->>'unreadableCount')::float) unreadable_photos,sum((terminal->>'matchesShown')::float) matches_shown,
 avg((terminal->>'setupMs')::float) average_setup_ms,avg((terminal->>'processingMs')::float) average_processing_ms,
 avg((presentation->>'presentationMs')::float) average_presentation_ms,
 avg((terminal->>'photosProcessed')::float*1000/nullif((terminal->>'processingMs')::float,0)) FILTER(WHERE terminal_type='search_completed') average_photos_per_wall_second,
 percentile_cont(0.95) WITHIN GROUP(ORDER BY (terminal->>'durationMs')::float) FILTER(WHERE terminal_type='search_completed') p95_search_ms
 FROM cohort)
 SELECT totals.*,searches_completed::float/nullif(searches_started,0) completion_rate,
 rated_completions::float/nullif(searches_completed,0) rating_coverage,
 reviewed_completions::float/nullif(searches_completed,0) review_coverage,
 (photos_processed-unreadable_photos)/nullif(photos_processed,0) readable_photo_rate,
 photos_processed/nullif(photos_planned,0) processed_photo_rate,
 (SELECT jsonb_build_object('started',count(*),'ended',count(e.event_id),'without_observed_end',count(*)-count(e.event_id),'average_duration_ms',avg((e.payload->>'durationMs')::float))
 FROM window_events s LEFT JOIN all_v2 e ON e.installation_id=s.installation_id AND e.type='session_ended' AND e.payload->>'sessionId'=s.payload->>'sessionId' WHERE s.type='session_started') sessions,
 (SELECT count(*)::int FROM window_events) event_sample_size,
 (SELECT count(*)::int FROM analytics_events WHERE schema_version=1 AND created_at >= $1 AND created_at < $2) legacy_event_sample_size,
 (SELECT jsonb_agg(b) FROM (SELECT platform,app_version,count(*)::int searches_started,count(*) FILTER(WHERE terminal_type='search_completed')::int searches_completed,
 avg((terminal->>'durationMs')::float) FILTER(WHERE terminal_type='search_completed') average_duration_ms,
 avg((rating->>'stars')::float) FILTER(WHERE terminal_type='search_completed') subjective_rating_average,
 count(rating)::int rating_samples FROM cohort GROUP BY platform,app_version ORDER BY platform,app_version) b) platform_versions,
 (SELECT jsonb_agg(b) FROM (SELECT (rating->>'stars')::int stars,count(*)::int searches,avg((terminal->>'durationMs')::float) average_duration_ms FROM cohort WHERE terminal_type='search_completed' AND rating IS NOT NULL GROUP BY 1 ORDER BY 1) b) rating_by_duration,
 (SELECT jsonb_build_object('sample_size',count(*),'average_delay_ms',avg(greatest(0,extract(epoch FROM(received_at-created_at))*1000)),
 'p95_delay_ms',percentile_cont(0.95) WITHIN GROUP(ORDER BY greatest(0,extract(epoch FROM(received_at-created_at))*1000)),
 'events_retried',count(*) FILTER(WHERE delivery_attempts>0),'average_attempts_before_acceptance',avg(delivery_attempts))
 FROM window_events WHERE received_at IS NOT NULL) delivery
 FROM totals`,[from,to]);
 return {schemaVersion:2,cohort:'Búsquedas v2 iniciadas en [from,to); final observado entre eventos aún retenidos.',deliveryPrecision:'createdAt v2 redondeado al minuto; retraso de entrega incluye hasta 60s de redondeo.',...rows[0]};
}
