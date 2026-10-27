import {randomBytes, randomUUID} from 'node:crypto';

const base = process.env.API_BASE_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '3000'}`;
const installationId = randomUUID();
const sessionId=randomUUID(),searchId=randomUUID();
const token = randomBytes(32).toString('hex');
let registered = false;
async function request(path, method, body, credential = token, expected = 200) {
  const response = await fetch(`${base}/v1/analytics${path}`, {
    method,
    headers: {Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== expected) throw new Error(`${method} ${path}: HTTP ${response.status}, esperado ${expected}`);
  console.log(`${method} ${path.split('?')[0]} → ${response.status}`);
  return response.json();
}
try {
  if (!process.env.ADMIN_TOKEN) throw new Error('Configura ADMIN_TOKEN en .env');
  await request('/installations', 'POST', {installationId});
  registered = true;
  const event = (type, payload) => ({eventId: randomUUID(), installationId, type, schemaVersion: 2, platform:'android',appVersion:'0.9.0+13',createdAt:new Date().toISOString(),payload:{sessionId,...(!type.startsWith('session_')?{searchId}:{}),...payload}});
  const events = [
    event('session_started', {}),
    event('search_started', {photosPlanned:20}),
    event('search_completed', {durationMs:1200,setupMs:200,processingMs:1000,timingSource:'live',photosPlanned:20,photosProcessed:20,unreadableCount:0,matchesShown:3}),
    event('results_presented',{presentationMs:16}),
    event('session_ended',{durationMs:2000}),
    event('results_rated', {stars: 4}),
    event('results_reviewed', {confirmed: 3, rejected: 1}),
  ];
  const accepted = await request('/events/batch', 'POST', {installationId, events});
  if (accepted.acceptedEventIds?.length !== events.length) throw new Error('Falta confirmación de eventos');
  await request('/events/batch', 'POST', {installationId, events});
  const from = new Date(Date.now() - 3600000).toISOString();
  const to = new Date(Date.now() + 1000).toISOString();
  const period = new URLSearchParams({from, to});
  await request(`/metrics?${period}`, 'GET', undefined, token, 401);
  const metrics = await request(`/metrics?${period}`, 'GET', undefined, process.env.ADMIN_TOKEN);
  if(metrics.related.searches_completed<1 || metrics.related.rated_completions<1)throw new Error('Falta correlación v2');
  console.log('Métricas actuales (incluyen otros datos locales, si existen):');
  console.log(JSON.stringify(metrics, null, 2));
  console.log('Registro, lote, reenvío idempotente y protección administrativa comprobados.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Prueba fallida');
  process.exitCode = 1;
} finally {
  if (registered) {
    try {
      await request(`/installations/${installationId}`, 'DELETE');
      console.log('Eventos de prueba eliminados. La API sigue disponible para tus pruebas.');
    } catch {
      console.error('No se pudo limpiar la instalación de prueba; sus eventos caducan por retención.');
      process.exitCode = 1;
    }
  }
}
