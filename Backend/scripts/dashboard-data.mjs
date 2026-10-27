import pg from 'pg';
export async function dashboardData(){
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:10000});
 try {
 const days=Number(process.env.RETENTION_DAYS??30),to=new Date(),from=new Date(to-days*86400000+60000);
 const base=`http://${process.env.HOST??'127.0.0.1'}:${process.env.PORT??3000}`;
 const response=await fetch(`${base}/v1/analytics/metrics?${new URLSearchParams({from:from.toISOString(),to:to.toISOString()})}`,{headers:{Authorization:`Bearer ${process.env.ADMIN_TOKEN}`},signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error(`API HTTP ${response.status}`);
 const {rows}=await pool.query(`WITH events AS (SELECT * FROM analytics_events WHERE schema_version=2),
 runs AS (SELECT installation_id,payload->>'searchId' AS sid,min(created_at) FILTER(WHERE type='search_started') AS started_at,
 min(created_at) AS first_at FROM events WHERE payload ? 'searchId' GROUP BY installation_id,payload->>'searchId')
 SELECT coalesce(r.started_at,r.first_at) AS date, t.created_at AS ended_at,
 coalesce(s.platform,t.platform) AS platform,coalesce(s.app_version,t.app_version) AS version,
 coalesce(t.type,'without_observed_end') AS outcome, t.payload->>'errorCategory' AS error_category,
 coalesce((s.payload->>'photosPlanned')::int,(t.payload->>'photosPlanned')::int) AS planned,
 (t.payload->>'photosProcessed')::int photos,(t.payload->>'processingMs')::float processing_ms,
 (t.payload->>'durationMs')::float duration_ms,(t.payload->>'setupMs')::float setup_ms,
 (t.payload->>'matchesShown')::int matches,(t.payload->>'unreadableCount')::int unreadable,
 (t.payload->>'cacheHits')::int cache_hits,(t.payload->>'cacheMisses')::int cache_misses,
 (t.payload->>'readMs')::float read_ms,(t.payload->>'decodeMs')::float decode_ms,(t.payload->>'engineMs')::float engine_ms,
 (t.payload->>'cancelLatencyMs')::float cancel_latency_ms,(t.payload->>'timeToCancelMs')::float time_to_cancel_ms,
 (rating.payload->>'stars')::int stars,(review.payload->>'confirmed')::int confirmed,(review.payload->>'rejected')::int rejected,
 (presented.payload->>'presentationMs')::float presentation_ms,
 greatest(0,extract(epoch FROM(t.received_at-t.created_at))*1000)::float delivery_ms,t.delivery_attempts
 FROM runs r
 LEFT JOIN events s ON s.installation_id=r.installation_id AND s.payload->>'searchId'=r.sid AND s.type='search_started'
 LEFT JOIN events t ON t.installation_id=r.installation_id AND t.payload->>'searchId'=r.sid AND t.type IN('search_completed','search_cancelled','search_failed','search_interrupted')
 LEFT JOIN events rating ON rating.installation_id=r.installation_id AND rating.payload->>'searchId'=r.sid AND rating.type='results_rated'
 LEFT JOIN events review ON review.installation_id=r.installation_id AND review.payload->>'searchId'=r.sid AND review.type='results_reviewed'
 LEFT JOIN events presented ON presented.installation_id=r.installation_id AND presented.payload->>'searchId'=r.sid AND presented.type='results_presented'
 WHERE (s.event_id IS NOT NULL OR t.event_id IS NOT NULL) AND coalesce(r.started_at,r.first_at)>=$1 AND coalesce(r.started_at,r.first_at)<$2
 ORDER BY date`,[from,to]);
 return {updatedAt:to.toISOString(),days,metrics:await response.json(),searches:rows};
 }finally{await pool.end();}
}
