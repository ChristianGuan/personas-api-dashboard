import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Pool} from 'pg';
import {migrate} from '../src/infrastructure/migrate';
test('HTTP closed contract, partial ACK, admin protection, safe errors and revocation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema='http_'+randomUUID().replaceAll('-','');
 const root=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 await root.query(`CREATE SCHEMA "${schema}"`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
 const db=new Pool({connectionString:url.toString()});
 const admin=randomBytes(32).toString('hex');const token=randomBytes(32).toString('hex');
 const port=31000+Math.floor(Math.random()*10000);const base=`http://127.0.0.1:${port}/v1/analytics`;
 let server:ReturnType<typeof spawn>|undefined;
 try {
  await migrate(db);
  server=spawn(process.execPath,['dist/main.js'],{env:{...process.env,DATABASE_URL:url.toString(),ADMIN_TOKEN:admin,PORT:String(port),RETENTION_DAYS:'30'},stdio:'ignore'});
  let ready=false;
  for(let i=0;i<100;i++){try{await fetch(base+'/metrics',{signal:AbortSignal.timeout(100)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,30));}}
  assert(ready,'server started');
  const docs=await fetch(`http://127.0.0.1:${port}/docs`);
  assert.equal(docs.status,200);assert((await docs.text()).includes('swagger-ui'));
  const openapi=await (await fetch(`http://127.0.0.1:${port}/docs-json`)).json() as any;
  assert.equal(Object.keys(openapi.paths).length,5);
  assert.deepEqual(openapi.paths['/v1/analytics/events/batch'].post.security,[{installationToken:[]}]);
  assert.deepEqual(openapi.paths['/v1/analytics/metrics'].get.security,[{adminToken:[]}]);
  assert.equal(openapi.components.schemas.AnalyticsEvent.oneOf.length,18);
  assert.equal(openapi.components.schemas.results_rated.properties.payload.additionalProperties,false);
  assert.equal(openapi.components.schemas.results_rated.properties.payload.properties.stars.maximum,5);
  assert(!JSON.stringify(openapi).includes(admin));
  for(const asset of ['swagger-ui-bundle.js','swagger-ui.css','swagger-ui-init.js']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/docs/${asset}`)).status,200);
  }
  const req=(path:string,method='GET',body?:unknown,credential=token)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const id=randomUUID();assert.equal((await req('/installations','POST',{installationId:id})).status,200);
  const valid={eventId:randomUUID(),installationId:id,type:'session_started',schemaVersion:1,createdAt:new Date().toISOString(),payload:{}};
  const response=await req('/events/batch','POST',{installationId:id,events:[valid,{...valid,eventId:randomUUID(),payload:{photoUri:'secret'}}]});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{acceptedEventIds:[valid.eventId],rejectedIndices:[1]});
  assert.equal((await req('/events/batch','POST',{installationId:id,events:[valid],album:'private'})).status,400);
  assert.equal((await req('/events/batch','POST',{installationId:id,events:[valid]},randomBytes(32).toString('hex'))).status,401);
  const period=`?from=${new Date(Date.now()-60000).toISOString()}&to=${new Date(Date.now()+1000).toISOString()}`;
  assert.equal((await req('/metrics'+period)).status,401);
  assert.equal((await req('/metrics'+period,'GET',undefined,admin)).status,200);
  const oversized=await req('/events/batch','POST',{installationId:id,events:[valid],forbidden:'s'.repeat(70000)});
  assert.equal(oversized.status,413);assert(!JSON.stringify(await oversized.json()).includes('ssssss'));
  assert.equal((await req(`/installations/${id}`,'DELETE',undefined,randomBytes(32).toString('hex'))).status,401);
  assert.equal((await req(`/installations/${id}`,'DELETE')).status,200);
  assert.equal((await req('/events/batch','POST',{installationId:id,events:[valid]})).status,401);
  assert.equal((await db.query('SELECT * FROM analytics_events')).rowCount,0);
 } finally {
  if(server && server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(r=>{server!.once('exit',()=>r());setTimeout(()=>{server!.kill('SIGKILL');r();},2000).unref();});}
  await db.end();await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();
 }
});
