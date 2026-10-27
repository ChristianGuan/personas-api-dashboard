# API de analítica opcional

Node.js >=22 (verificado con 24.11), TypeScript, NestJS11 y PostgreSQL17. No recibe imágenes ni realiza reconocimiento. Ejecutar los comandos desde `Backend/`.

```sh
cp .env.example .env
# Editar .env: elegir POSTGRES_PASSWORD y un ADMIN_TOKEN aleatorio de al menos32 caracteres.
# Generar un valor local con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# DATABASE_URL=postgresql://personas:<password-url-encoded>@127.0.0.1:5432/personas_analytics
npm ci
# Requiere Docker Desktop iniciado.
docker compose up -d --wait
npm run migrate
npm run build
npm start
# Alternativa desarrollo: npm run dev
```

No hay contraseñas ni tokens de ejemplo funcionales. `.env` está ignorado. `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` configuran Docker; `DATABASE_URL` configura Node; `HOST`/`PORT` (127.0.0.1/3000) limitan escucha; `ADMIN_TOKEN` protege métricas; `RETENTION_DAYS` entero1..30, predeterminado30. No pasar ADMIN_TOKEN a Flutter. Para probar desde un teléfono, usar un proxy HTTPS local con certificado confiable y configurar `ANALYTICS_API_URL`; no abrir PostgreSQL en la red.

## Organización

- `src/domain`: evento, contratos de repositorio y error de acceso; sin dependencias de Nest/pg.
- `src/application`: casos de uso de registro, ingesta, borrado y reportes.
- `src/infrastructure`: adaptador `pg`, configuración, migraciones y mantenimiento.
- `src/presentation`: controlador NestJS y validación Zod estricta.
- `src/main.ts`: composición, límites y manejo seguro de errores. No se crea una capa shared sin responsabilidad.

`001_analytics.sql` crea installations, catálogo event_types, analytics_events y daily_metrics. UUID PK/FK, índices de fecha/instalación/tipo, payload jsonb con CHECK adicional en PostgreSQL. `schema_migrations` aplica cada archivo una sola vez, bajo lock y transacción. El script de migración también funciona tras `npm run build`; conservar `src/infrastructure/migrations` al empaquetar.

## Contrato HTTP v1

JSON, máximo64KiB por petición, máximo50 eventos/lote. Sólo HTTPS en despliegue. No CORS abierto, cookies, subida de archivos ni SDK de terceros. `Authorization: Bearer <credencial64hex>` para cliente; credencial aleatoria creada sólo tras consentimiento, hashSHA256 en PostgreSQL. No es una clave secreta del backend. Cada instalación conserva su propia credencial en Keychain/almacenamiento cifrado.

| Método/ruta | Petición | Respuesta200 |
|---|---|---|
| POST `/v1/analytics/installations` | `{installationId: UUIDv4}` | `{registered:true}` |
| POST `/v1/analytics/events/batch` | `{installationId,events:[evento]}` | `{acceptedEventIds:[UUID],rejectedIndices:[índice]}` |
| DELETE `/v1/analytics/installations/:id` | sin body, bearer propio | `{deleted:true}` |
| GET `/v1/analytics/metrics?from=ISO&to=ISO` | bearer ADMIN_TOKEN | métricas de ventana `[from,to)` |
| GET `/v1/analytics/history` | bearer ADMIN_TOKEN | hasta10000 agregados diarios, recientes primero |

Evento: `{eventId,installationId,type,schemaVersion:1,createdAt:ISO8601,payload:{...}}`. UUIDv4, fecha últimas RETENTION_DAYS con tolerancia futura5min. El ID de instalación del evento debe coincidir con el envelope. `createdAt` Flutter redondea a hora UTC para reducir granularidad; usar periodos alineados a hora/día. Sólo se admiten estos payloads:

| type | payload exacto |
|---|---|
| session_started / search_started | `{}` |
| session_ended | `{durationMs}` |
| search_completed | `{durationMs,photoRange,matchRange}` |
| search_cancelled | `{durationMs,photoRange}` |
| search_failed | `{durationMs,errorCategory}` |
| results_rated | `{stars}` |
| results_reviewed | `{confirmed,rejected}` |

Duración entero0..86400000ms; rangos `0`,`1-25`,`26-100`,`101-500`,`501+`; 0 representa conjunto vacío, no una valoración omitida. Categorías `permission`,`storage`,`processing`,`unknown`; Flutter usa processing para fallos generales del motor, sin texto/trazas. Estrellas1..5. Totales0..1000000 y suma>0. Campos extra, strings arbitrarios o tipos incorrectos se rechazan; no se registran sus valores.

Envelope inválido400; eventos individuales inválidos aparecen en rejectedIndices y no se guardan. Todos los aceptables se procesan en una transacción; un fallo SQL devuelve500 y revierte lote. Deduplicación eventId acepta un reenvío idéntico; un ID con contenido/instalación distinta no se acepta. Sólo acceptedEventIds autoriza eliminar de la outbox. Los eventos rechazados quedan pendientes con backoff hasta su TTL o revocación: no se pierden por una respuesta parcial. Errores genéricos400/401/413/429/500, sin cuerpos recibidos, cabeceras, trazas ni datos personales en logs.

Registro idempotente con misma credencial. DELETE exige hash correcto y bloquea la instalación en la misma transacción que borra eventos. Una eliminación de instalación nunca registrada crea tombstone autenticado; así también funcionan consentimiento offline y revocación antes del primer envío. Tombstone30d evita resurrección por peticiones tardías y permite reintentar borrado; aceptar de nuevo crea otra instalación. Tras30d se elimina tombstone; no reutilizar UUID. No se pueden borrar agregados anónimos ya desvinculados. Desinstalar borra el acceso a credenciales; sin cuenta no se puede autenticar borrado desde otro equipo. Los eventos restantes caducan por retención.

## Reportes y retención

Ventana de reportes dentro de últimos RETENTION_DAYS, `to<=ahora+5min`. Campos: active_installations, sessions_per_active_installation, searches_per_active_installation, search_completion_rate, average_search_duration_ms, median_search_duration_ms, subjective_rating_average/distribution, user_confirmed_match_rate y contadores. Ratios0..1 cuando los eventos corresponden al mismo conjunto; una ventana cortada puede tener inicios/finales de búsquedas diferentes. No son métricas por cohortes ni de precisión técnica. Ausencia de respuestas/denominador devuelve null («sin datos»).

Sesión = entrada a primer plano (no cada selector del sistema); duración por Stopwatch hasta pausa. El sistema puede terminar proceso sin emitir fin: no se inventan cierres ni búsquedas completadas. Revisión explícita envía totales una vez por búsqueda; modificaciones posteriores son sólo locales. El motor puede reutilizar confirmaciones previas durante la sesión; los totales reflejan lo mostrado y confirmado en la revisión actual.

Mantenimiento al arrancar, antes de lotes/reportes y cada hora: agrupa y elimina eventos vencidos transaccionalmente. `npm run retention` permite cron externo para cumplir retención aunque el servidor HTTP esté detenido. Monitorizar ejecución; una política temporal necesita que el proceso/cron esté operativo y que backups tengan la misma expiración. Instalaciones inactivas sin eventos también caducan; tombstones duran30d. Histórico guarda sólo día, tipo, dimensión enumerada, conteo y suma: estrellas, rangos, errores, duraciones por segundos. No hay UUID ni conjuntos de instalaciones en agregados. No se pueden reconstruir instalaciones únicas de periodos históricos; no sumar activos diarios como si fueran únicos. Mediana histórica sólo aproximable con histograma, mientras endpoint reciente usa percentile_cont exacto.

## Seguridad operativa

Límite por IP en memoria60peticiones/min, registro10/min; IP sólo transitoria para limitar, no persistida. Cliente público no prueba ser un dispositivo real: antes de un servicio público añadir cuota global, límite de instalaciones/almacenamiento y rate limiter compartido en gateway si hay réplicas. No habilitar trust proxy indiscriminadamente. TLS en proxy, sin logs de cuerpos/Authorization/IP del servicio, configurar también proxy/hosting; PostgreSQL remoto con TLS verificado, rol runtime de privilegios mínimos y rol de migración separado. Docker local usa loopback, no representa un despliegue público. No provisionado nada externo.

## Pruebas

```sh
npm run build
npm test # validación; integración se omite si no se suministra DB de prueba
# Sólo base desechable: las pruebas crean y eliminan esquemas aislados.
TEST_DATABASE_URL=postgresql://... npm test
```

Cubren migraciones repetibles, constraints, rollback, ACK parcial HTTP, deduplicación/colisiones, aislamiento de instalación, autenticación de borrado/admin, límites JSON, métricas/null y retención concurrente. No usar una base de producción como TEST_DATABASE_URL.

## Prueba rápida de la API

Con PostgreSQL y la API en ejecución, desde otra terminal en `Backend/`:

```sh
npm run smoke
```

Usa la URL local y ADMIN_TOKEN de `.env` sin imprimir credenciales. Crea una instalación aleatoria de prueba, envía siete eventos sintéticos v2, reenvía el lote, comprueba que las métricas exigen autorización y consulta el reporte. Finalmente elimina sus eventos con la credencial propia. No envía imágenes ni toca instalaciones existentes. Las métricas del reporte incluyen los demás eventos locales que ya existan. Configura `API_BASE_URL` si tu API escucha en otra dirección.

La raíz `/` no es una página web. Swagger está disponible en `/docs` y su contrato OpenAPI en `/docs-json`. Para peticiones manuales en Postman/Insomnia usa las rutas y cuerpos de la tabla anterior; los endpoints administrativos requieren `Authorization: Bearer <ADMIN_TOKEN de .env>`, y registro/lotes/borrado usan una credencial aleatoria distinta de64 caracteres hexadecimales creada por tu cliente de prueba.


## Swagger interactivo

Con la API iniciada, abre http://127.0.0.1:3000/docs. El contrato JSON está en http://127.0.0.1:3000/docs-json (importable en Postman). Los esquemas de payload se derivan de los validadores Zod; restricciones temporales, suma de evaluaciones y confirmaciones parciales están descritas en las operaciones.

1. Pulsa **Authorize**. En `installationToken`, pega una credencial de prueba aleatoria64hex, sin el prefijo Bearer. Puedes generarla con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. En **POST installations**, pulsa **Try it out** y **Execute** con un UUIDv4 de instalación; puedes generarlo con `node -e "console.log(require('crypto').randomUUID())"`.
3. Usa el mismo UUID y token para **POST events/batch**; cambia `eventId` para cada evento y `createdAt` a una fecha actual. Los ocho tipos de evento y payloads aparecen en Schemas. Reenviar el mismo evento idéntico confirma el mismo ID sin duplicarlo.
4. Para **GET metrics** e **history**, autoriza `adminToken` usando ADMIN_TOKEN de tu `.env` local. Mantén las fechas dentro de RETENTION_DAYS. El token de instalación no da acceso administrativo.
5. Para limpiar tus datos sintéticos, ejecuta **DELETE installations/{id}** con el token de esa instalación. El UUID queda revocado; crea otro si deseas seguir probando.

Swagger no incrusta tokens ni los guarda al recargar. La documentación expone sólo el contrato; los endpoints siguen exigiendo sus credenciales. La UI y sus recursos se sirven localmente con @nestjs/swagger11, compatible con NestJS11; no hay validador externo. Integración basada en la [documentación oficial de NestJS](https://docs.nestjs.com/openapi/introduction).

## Eventos relacionados v2 (app0.9.0+13)

Se conserva `/v1/analytics` y se aceptan los eventos schemaVersion1 existentes. La migración `002_related_metrics.sql` es aditiva, conserva esos datos y no les inventa plataforma, versión o fecha de recepción. Ejecutar `npm run migrate` antes de iniciar esta versión. No hay variables de entorno adicionales.

Envelope v2 obligatorio: `{eventId,installationId,type,schemaVersion:2,createdAt,platform:"ios"|"android",appVersion:"0.9.0+13",payload}`; deliveryAttempts opcional0..1000000 cuenta intentos previos a aceptación y no cambia identidad del evento al reenviarlo. appVersion sólo acepta versión numérica+build. received_at lo escribe PostgreSQL al recibir, no Flutter. Los eventos v2 se fechan al minuto UTC: las métricas de retraso incluyen hasta60s de redondeo. Los v1 mantienen su granularidad horaria y no entran en el reporte relacionado.

Todos los payloads v2 incluyen sessionId UUIDv4 aleatorio. Los de búsqueda, resultados y valoración añaden searchId UUIDv4; ambos pertenecen sólo a la instalación, nunca a una foto/persona. No son IDs de dispositivo. Las uniones del reporte incluyen installation_id para impedir relacionar instalaciones por UUID coincidente.

| Evento v2 | Campos adicionales a sessionId |
|---|---|
| session_started | ninguno |
| session_ended | durationMs |
| search_started | searchId, photosPlanned |
| search_completed / search_cancelled | searchId, photosPlanned, photosProcessed, unreadableCount, matchesShown, timingSource y tiempos si disponibles |
| search_failed | los del final + errorCategory (permission/storage/processing/unknown) |
| search_interrupted | searchId, photosPlanned, errorCategory=process_interrupted; sin duración inventada |
| results_rated | searchId, stars1..5 |
| results_reviewed | searchId, confirmed, rejected; suma>0 |
| results_presented | searchId, presentationMs |

Conteos enteros0..1000000; processed<=planned y unreadable+matches<=processed. timingSource=live exige durationMs/setupMs/processingMs (0..86400000, setup+processing<=duration). timingSource=unavailable prohíbe los tres: ocurre al restaurar un final nativo sin reloj Dart vivo. Nunca se rellena con cero ni con tiempo desde la reapertura. setup incluye preparación de ejecución/permisos; processing es tiempo de pared del worker e incluye suspensión, descodificación/inferencia y entrega de callbacks. No equivale al tiempo puro de inferencia. presentation mide hasta el primer frame de resultados tras observar el final en Dart.

Índices únicos garantizan un inicio, un final mutuamente excluyente, una valoración y una revisión por instalación/búsqueda, y un inicio/fin por sesión. Un evento de conflicto semántico no se acepta aunque use otro eventId; reenvíos con mismo eventId/contenido sí se aceptan. Flutter conserva marcas durables para no generar esos duplicados al restaurar/reintentar. La recepción desordenada es válida y la correlación se completa al llegar el inicio.

El GET protegido `/metrics` añade `related`, sin quitar los campos existentes:

- Cohorte de búsquedas v2 iniciadas dentro de `[from,to)`: completadas, canceladas, fallidas, interrumpidas y sin final observado. Su final puede haberse recibido fuera de esa ventana siempre que aún esté retenido. «Sin final observado» no prueba fallo: puede estar activa o pendiente de sincronizar.
- `platform_versions`: búsquedas/tiempo/valoración por plataforma y versión, con tamaño de muestra.
- Fotos previstas/procesadas/no legibles, coincidencias mostradas, fracción procesada/legible y media de fotos por segundo de pared (sólo completadas con tiempo medido>0).
- Setup, procesamiento, presentación, p95 y completed_timing_samples; datos ausentes devuelven null.
- Cobertura de estrellas/revisión entre búsquedas completadas y `rating_by_duration` une cada valoración con su propia búsqueda. Es subjetiva y no precisión técnica.
- `sessions`: sesiones iniciadas, finalizadas, sin cierre observado y duración media enlazadas por UUID de sesión.
- `delivery`: cantidad de eventos v2 con recepción conocida, retraso promedio/p95, eventos con reintentos y promedio de intentos previos.
- event_sample_size y legacy_event_sample_size permiten ver cuánto dato procede de cada esquema. No extrapolar comparaciones de plataforma a los v1.

Tras el TTL se eliminan los eventos, IDs de sesión/búsqueda e instalación según política existente. daily_metrics sólo conserva dimensiones enumeradas/sumas por plataforma, conteos, fases, errores y estrellas, sin UUID ni versión arbitraria; no permite reconstruir las cohortes históricas. Los agregados no permiten consultar fotos individuales ni relacionar sus identidades.

## Diagnóstico de procesamiento

La migración `003_processing_diagnostics.sql` añade validación para campos opcionales de los finales v2: `readMs`, `decodeMs`, `engineMs`, `cacheHits`, `cacheMisses`, `timeToCancelMs` y `cancelLatencyMs`. Los eventos antiguos siguen siendo válidos. Los contadores de caché deben enviarse juntos y su suma no puede superar `photosProcessed`. Los tiempos son enteros entre 0 y 86400000 ms; los contadores, entre 0 y 1000000.

Estos datos no incluyen fotos, hashes ni rutas. Las etapas pueden solaparse por prefetch y no equivalen a inferencia pura. Las mediciones ausentes no representan cero. Se conservan con la misma retención que el evento.

Los scripts opcionales `scripts/dashboard-data.mjs` y `scripts/dashboard-server.mjs` sirven de apoyo al dashboard local y necesitan sus archivos en `../dashboard-metricas/dist/`, incluidos en este mismo repositorio. No son necesarios para iniciar la API. `scripts/processing-report.mjs` genera un reporte Markdown local en `../reports/`.
