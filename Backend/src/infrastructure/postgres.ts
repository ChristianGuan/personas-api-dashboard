import { Pool, PoolClient } from 'pg';
import { relatedMetrics } from './related-metrics';
import { AccessDenied, AnalyticsEvent, AnalyticsRepository } from '../domain/analytics';
export class PostgresAnalytics implements AnalyticsRepository {
  constructor(readonly pool: Pool, readonly retentionDays = 30) {}
  private async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const value = await work(c); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  private async authorize(c: PoolClient, id: string, hash: string, allowDeleted = false) {
    const {rows} = await c.query('SELECT token_hash, deleted_at FROM installations WHERE id=$1 FOR UPDATE', [id]);
    if (!rows.length || rows[0].token_hash !== hash || (!allowDeleted && rows[0].deleted_at)) throw new AccessDenied();
    return rows[0];
  }
  async register(id: string, hash: string) {
    await this.transaction(async c => {
      await c.query('INSERT INTO installations(id,token_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,hash]);
      await this.authorize(c,id,hash);
      await c.query('UPDATE installations SET last_seen=now() WHERE id=$1',[id]);
    });
  }
  async ingest(id: string, hash: string, events: AnalyticsEvent[]) {
    await this.retain();
    return this.transaction(async c => {
      await this.authorize(c,id,hash);
      const accepted: string[] = [];
      for (const e of events) {
        // Check expiry in transaction as well: a request may wait for a row lock.
        const values=[e.eventId,e.installationId,e.type,e.schemaVersion,e.createdAt,JSON.stringify(e.payload),id,this.retentionDays,e.platform??null,e.appVersion??null,e.deliveryAttempts??0];
        const inserted=await c.query(`INSERT INTO analytics_events(event_id,installation_id,type,schema_version,created_at,payload,platform,app_version,received_at,delivery_attempts)
          SELECT $1,$2,$3,$4,$5,$6,$9,$10,now(),$11 WHERE $2::uuid=$7::uuid AND $5::timestamptz>=now()-make_interval(days=>$8) AND $5::timestamptz<=now()+interval '5 minutes'
          ON CONFLICT DO NOTHING RETURNING event_id`,values);
        if(inserted.rows.length) {accepted.push(e.eventId);continue;}
        // Retry metadata is mutable; the identity/content of the event is not.
        const existing=await c.query(`UPDATE analytics_events SET delivery_attempts=greatest(delivery_attempts,$11)
          WHERE event_id=$1 AND installation_id=$2 AND type=$3 AND schema_version=$4 AND created_at=$5 AND payload=$6::jsonb
          AND $2::uuid=$7::uuid AND created_at>=now()-make_interval(days=>$8)
          AND platform IS NOT DISTINCT FROM $9::text AND app_version IS NOT DISTINCT FROM $10::text RETURNING event_id`,values);
        if(existing.rows.length) accepted.push(e.eventId);
      }
      await c.query('UPDATE installations SET last_seen=now() WHERE id=$1',[id]);
      return accepted;
    });
  }
  async remove(id: string, hash: string) {
    await this.transaction(async c => {
      await c.query('INSERT INTO installations(id,token_hash,deleted_at) VALUES($1,$2,now()) ON CONFLICT DO NOTHING',[id,hash]);
      await this.authorize(c,id,hash,true);
      await c.query('DELETE FROM analytics_events WHERE installation_id=$1',[id]);
      await c.query('UPDATE installations SET deleted_at=coalesce(deleted_at,now()) WHERE id=$1',[id]);
    });
  }
  async metrics(from: Date, to: Date): Promise<Record<string, unknown>> {
    const {rows} = await this.pool.query(`WITH e AS (SELECT * FROM analytics_events WHERE created_at >= $1 AND created_at < $2), s AS (
      SELECT count(DISTINCT installation_id)::float AS active_installations,
      count(*) FILTER(WHERE type='session_started')::float AS sessions,
      count(*) FILTER(WHERE type='search_started')::float AS searches_started,
      count(*) FILTER(WHERE type='search_completed')::float AS searches_completed,
      count(*) FILTER(WHERE type='search_cancelled')::float AS searches_cancelled,
      count(*) FILTER(WHERE type='search_failed')::float AS searches_failed,
      avg((payload->>'durationMs')::float) FILTER(WHERE type='search_completed') AS average_search_duration_ms,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY (payload->>'durationMs')::float) FILTER(WHERE type='search_completed') AS median_search_duration_ms,
      avg((payload->>'stars')::float) FILTER(WHERE type='results_rated') AS subjective_rating_average,
      sum((payload->>'confirmed')::float) FILTER(WHERE type='results_reviewed') AS confirmed,
      sum((payload->>'rejected')::float) FILTER(WHERE type='results_reviewed') AS rejected
      FROM e)
      SELECT s.*, sessions/nullif(active_installations,0) AS sessions_per_active_installation,
      searches_started/nullif(active_installations,0) AS searches_per_active_installation,
      searches_completed/nullif(searches_started,0) AS search_completion_rate,
      confirmed/nullif(confirmed+rejected,0) AS user_confirmed_match_rate,
      (SELECT jsonb_object_agg(stars,n) FROM (SELECT payload->>'stars' stars,count(*) n FROM e WHERE type='results_rated' GROUP BY 1) r) AS subjective_rating_distribution,
      (SELECT jsonb_object_agg(type,n) FROM (SELECT type,count(*) n FROM e GROUP BY 1) r) AS event_counts
      FROM s`,[from,to]);
    return {from: from.toISOString(), to: to.toISOString(), ...rows[0], related: await relatedMetrics(this.pool,from,to)};
  }
  async history() {
    return (await this.pool.query('SELECT day,type,dimension,count,total FROM daily_metrics ORDER BY day DESC,type,dimension LIMIT 10000')).rows;
  }
  async retain() {
    await this.transaction(async c => {
      // Serialize retention jobs; ingestion is also run behind this maintenance barrier in HTTP.
      await c.query('SELECT pg_advisory_xact_lock(7381042)');
      await c.query(`WITH expired AS (DELETE FROM analytics_events WHERE created_at < now()-make_interval(days=>$1) RETURNING *),
        dimensions AS (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day,type,'events' AS dimension,1::bigint AS count,0::numeric AS total FROM expired
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'duration_seconds:'||floor((payload->>'durationMs')::numeric/1000)::text,1,(payload->>'durationMs')::numeric FROM expired WHERE type IN ('search_completed','session_ended') AND payload ? 'durationMs'
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'stars:'||(payload->>'stars'),1,(payload->>'stars')::numeric FROM expired WHERE type='results_rated'
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'confirmed',1,(payload->>'confirmed')::numeric FROM expired WHERE type='results_reviewed'
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'rejected',1,(payload->>'rejected')::numeric FROM expired WHERE type='results_reviewed'
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'photos:'||(payload->>'photoRange'),1,0 FROM expired WHERE type IN ('search_completed','search_cancelled') AND schema_version=1
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'matches:'||(payload->>'matchRange'),1,0 FROM expired WHERE type='search_completed' AND schema_version=1
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'error:'||(payload->>'errorCategory'),1,0 FROM expired WHERE type='search_failed'
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'platform:'||platform,1,0 FROM expired WHERE schema_version=2
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'processed',1,(payload->>'photosProcessed')::numeric FROM expired WHERE schema_version=2 AND type IN('search_completed','search_cancelled','search_failed')
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'unreadable',1,(payload->>'unreadableCount')::numeric FROM expired WHERE schema_version=2 AND type IN('search_completed','search_cancelled','search_failed')
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'matches',1,(payload->>'matchesShown')::numeric FROM expired WHERE schema_version=2 AND type IN('search_completed','search_cancelled','search_failed')
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'delivery_attempts',1,delivery_attempts FROM expired WHERE received_at IS NOT NULL
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'setup_ms',1,(payload->>'setupMs')::numeric FROM expired WHERE schema_version=2 AND payload ? 'setupMs' AND type IN('search_completed','search_cancelled','search_failed')
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'processing_ms',1,(payload->>'processingMs')::numeric FROM expired WHERE schema_version=2 AND payload ? 'processingMs' AND type IN('search_completed','search_cancelled','search_failed')
          UNION ALL SELECT (created_at AT TIME ZONE 'UTC')::date,type,'presentation_ms',1,(payload->>'presentationMs')::numeric FROM expired WHERE type='results_presented'
        ) INSERT INTO daily_metrics(day,type,dimension,count,total) SELECT day,type,dimension,sum(count),sum(total) FROM dimensions GROUP BY day,type,dimension
        ON CONFLICT(day,type,dimension) DO UPDATE SET count=daily_metrics.count+EXCLUDED.count,total=daily_metrics.total+EXCLUDED.total`,[this.retentionDays]);
      await c.query(`DELETE FROM installations i WHERE
        ((deleted_at IS NOT NULL AND deleted_at < now()-interval '30 days') OR (deleted_at IS NULL AND last_seen < now()-make_interval(days=>$1)))
        AND NOT EXISTS(SELECT 1 FROM analytics_events e WHERE e.installation_id=i.id)`,[this.retentionDays]);
    });
  }
}
