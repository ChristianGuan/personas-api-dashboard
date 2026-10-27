import pg from 'pg';
import {mkdir,writeFile} from 'node:fs/promises';

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
try {
  const {rows} = await pool.query(`SELECT created_at, platform, app_version,
    (payload->>'photosProcessed')::int photos,
    (payload->>'processingMs')::float processing_ms,
    (payload->>'durationMs')::float duration_ms
    FROM analytics_events WHERE schema_version=2 AND type='search_completed'
    AND created_at >= now()-($1::int * interval '1 day')
    ORDER BY created_at`, [Number(process.env.RETENTION_DAYS ?? 30)]);
  const fmt = n => n == null ? 'Sin datos' : n.toLocaleString('es-CO', {maximumFractionDigits:2});
  const measured = rows.filter(r => r.processing_ms > 0);
  function stats(items) {
    const photos=items.reduce((s,r)=>s+r.photos,0), ms=items.reduce((s,r)=>s+r.processing_ms,0);
    return [items.length,photos,ms/1000,ms ? photos*1000/ms:null,items.length?items.reduce((s,r)=>s+r.photos*1000/r.processing_ms,0)/items.length:null];
  }
  const stamp=new Date().toLocaleString('es-CO',{timeZone:'America/Bogota'});
  let report=`# Reporte de velocidad de procesamiento\n\nConsulta: ${stamp} (Colombia). Período: últimos ${process.env.RETENTION_DAYS??30} días.\n\nBúsquedas v2 completadas: ${rows.length}; con tiempo de procesamiento mayor que cero: ${measured.length}.\n\n| Plataforma | Búsquedas medidas | Fotos | Procesamiento total (s) | Velocidad global (fotos/s) | Promedio por búsqueda (fotos/s) |\n|---|---:|---:|---:|---:|---:|\n`;
  for(const platform of [...new Set(measured.map(r=>r.platform))]) report+=`| ${platform} | ${stats(measured.filter(r=>r.platform===platform)).map(fmt).join(' | ')} |\n`;
  report+=`| Total | ${stats(measured).map(fmt).join(' | ')} |\n\n## Detalle de búsquedas\n\n| Fecha (Colombia) | Plataforma | Versión | Fotos | Procesamiento (s) | Duración total (s) | Fotos/s |\n|---|---|---|---:|---:|---:|---:|\n`;
  for(const r of rows) report+=`| ${new Date(r.created_at).toLocaleString('es-CO',{timeZone:'America/Bogota'})} | ${r.platform} | ${r.app_version} | ${fmt(r.photos)} | ${fmt(r.processing_ms==null?null:r.processing_ms/1000)} | ${fmt(r.duration_ms==null?null:r.duration_ms/1000)} | ${fmt(r.processing_ms>0?r.photos*1000/r.processing_ms:null)} |\n`;
  report+='\n## Interpretación\n\nLa velocidad global divide las fotos totales por el tiempo total de procesamiento. El promedio por búsqueda da igual peso a cada ejecución. Se excluyen de los cálculos de velocidad las ejecuciones sin tiempo positivo.\n\nEl procesamiento mide tiempo de pared: incluye suspensión, lectura, decodificación, inferencia y entrega de callbacks. No mide exclusivamente la inferencia. La carga y las condiciones de los dispositivos pueden variar; estos datos no establecen por sí solos una superioridad de plataforma. Las búsquedas v1 no incluyen el detalle necesario y quedan excluidas.\n';
  await mkdir('../reports', {recursive:true});
  await writeFile('../reports/velocidad-procesamiento.md', report);
  console.log(report);
} finally { await pool.end(); }
