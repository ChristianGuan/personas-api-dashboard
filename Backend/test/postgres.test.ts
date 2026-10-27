import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../src/infrastructure/migrate';
import {PostgresAnalytics} from '../src/infrastructure/postgres';
import {AnalyticsEvent} from '../src/domain/analytics';
// Requires a disposable database; never points at DATABASE_URL implicitly.
test('PostgreSQL migrations, payload constraints, transactions, deduplication, metrics, retention and authenticated deletion',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='test_'+randomUUID().replaceAll('-','');
 const client=await pool.connect();
 try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  client.release();
  // Single pooled connection preserves isolated search_path.
  await pool.end();
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,options:`-c search_path=${schema}`});
  try {
   await migrate(db);await migrate(db);
   const repo=new PostgresAnalytics(db),id=randomUUID(),other=randomUUID(),hash=createHash('sha256').update('test-only').digest('hex');
   await repo.register(id,hash);await repo.register(id,hash);await repo.register(other,'a'.repeat(64));
   await assert.rejects(repo.register(id,'b'.repeat(64)));
   const make=(type:AnalyticsEvent['type'],payload:AnalyticsEvent['payload']):AnalyticsEvent=>({eventId:randomUUID(),installationId:id,type,schemaVersion:1,createdAt:new Date().toISOString(),payload});
   const started=make('search_started',{}),completed=make('search_completed',{durationMs:2000,photoRange:'1-25',matchRange:'1-25'});
   const events=[make('session_started',{}),started,completed,make('results_rated',{stars:4}),make('results_reviewed',{confirmed:3,rejected:1})];
   assert.equal((await repo.ingest(id,hash,events)).length,5);
   assert.equal((await repo.ingest(id,hash,events)).length,5);
   assert.equal((await db.query('SELECT * FROM analytics_events')).rowCount,5);
   assert.equal((await repo.ingest(other,'a'.repeat(64),[{...started,installationId:other}])).length,0);
   assert.equal((await repo.ingest(id,hash,[{...completed,payload:{...completed.payload,durationMs:3000}}])).length,0);
   const valid=make('session_started',{});
   await assert.rejects(repo.ingest(id,hash,[valid,make('session_started',{album:'forbidden'})]));
   assert.equal((await db.query('SELECT * FROM analytics_events')).rowCount,5); // whole batch rolled back
   const metrics=await repo.metrics(new Date(Date.now()-60000),new Date(Date.now()+60000));
   assert.equal(metrics.active_installations,1);assert.equal(metrics.search_completion_rate,1);
   assert.equal(metrics.average_search_duration_ms,2000);assert.equal(metrics.median_search_duration_ms,2000);
   assert.equal(metrics.subjective_rating_average,4);assert.equal(metrics.user_confirmed_match_rate,0.75);
   const empty=await repo.metrics(new Date(Date.now()-120000),new Date(Date.now()-60000));
   assert.equal(empty.subjective_rating_average,null);assert.equal(empty.user_confirmed_match_rate,null);
   await db.query("UPDATE analytics_events SET created_at=now()-interval '31 days' WHERE event_id=$1",[completed.eventId]);
   await Promise.all([repo.retain(),repo.retain()]);
   assert.equal((await db.query('SELECT * FROM analytics_events')).rowCount,4);
   const history=await repo.history();assert.equal(history.length,5);
   assert(!JSON.stringify(history).includes(id));
   await assert.rejects(repo.remove(id,'c'.repeat(64)));
   await repo.remove(id,hash);await repo.remove(id,hash);
   assert.equal((await db.query('SELECT * FROM analytics_events')).rowCount,0);
   await assert.rejects(repo.ingest(id,hash,[make('session_started',{})]));
   await assert.rejects(repo.register(id,hash));
   const neverSent=randomUUID();await repo.remove(neverSent,hash);await assert.rejects(repo.register(neverSent,hash));
  } finally {await db.end();}
 } finally {
  const cleanup=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await cleanup.end();
 }
});
