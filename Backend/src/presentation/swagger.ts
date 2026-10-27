import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject, ReferenceObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { eventSchema, payloads, payloadsV2, registrationSchema } from './validation';
import { eventTypes } from '../domain/analytics';

const ref = (name: string) => ({$ref: `#/components/schemas/${name}`});
const jsonSchema = (schema: z.ZodType): SchemaObject => z.toJSONSchema(schema, {target: 'openapi-3.0', unrepresentable: 'any'}) as SchemaObject;
const object = (properties: Record<string, SchemaObject | ReferenceObject>, required = Object.keys(properties)): SchemaObject => ({type:'object', additionalProperties:false, properties, required});
export function analyticsSchemas(retentionDays: number): Record<string, SchemaObject> {
  const base = jsonSchema(eventSchema(retentionDays));
  const schemas: Record<string, SchemaObject> = {};
  const names:string[]=[];
  for (const type of Object.keys(payloads) as (keyof typeof payloads)[]) {
    const properties: Record<string,SchemaObject>={...base.properties,type:{type:'string',enum:[type]} as SchemaObject,schemaVersion:{type:'integer',enum:[1]} as SchemaObject,payload:jsonSchema(payloads[type])};
    delete properties.platform;delete properties.appVersion;
    schemas[type]={...base,properties};names.push(type);
  }
  for(const type of eventTypes) {
    schemas[type+'_v2']={...base,required:[...base.required!,'platform','appVersion'],properties:{...base.properties,type:{type:'string',enum:[type]},schemaVersion:{type:'integer',enum:[2]},payload:jsonSchema(payloadsV2[type])}};
    names.push(type+'_v2');
  }
  schemas.AnalyticsEvent={oneOf:names.map(ref),description:`Eventos v1 compatibles y v2 relacionados. v2 exige plataforma, versión y sessionId; búsquedas añaden searchId aleatorio. Fechas últimas ${retentionDays}d, futuro5min. Conteos coherentes, setupMs+processingMs<=durationMs; confirmed+rejected>0. Ningún campo adicional ni dato facial.`};
  schemas.Registration = jsonSchema(registrationSchema);
  schemas.Batch = object({installationId:{type:'string',format:'uuid'},events:{type:'array',minItems:1,maxItems:50,items:ref('AnalyticsEvent')}});
  schemas.BatchAck = object({acceptedEventIds:{type:'array',items:{type:'string',format:'uuid'}},rejectedIndices:{type:'array',items:{type:'integer',minimum:0,maximum:49}}});
  schemas.Error = object({error:{type:'string',enum:['Request rejected','Internal error']}});
  schemas.Registered = object({registered:{type:'boolean',enum:[true]}});
  schemas.Deleted = object({deleted:{type:'boolean',enum:[true]}});
  const metricFields = ['active_installations','sessions','searches_started','searches_completed','searches_cancelled','searches_failed','average_search_duration_ms','median_search_duration_ms','subjective_rating_average','confirmed','rejected','sessions_per_active_installation','searches_per_active_installation','search_completion_rate','user_confirmed_match_rate'];
  const numeric=(nullable=true):SchemaObject=>({type:'number',nullable});
  const relatedNumbers=['searches_started','searches_completed','searches_cancelled','searches_failed','searches_interrupted','without_observed_end','completed_timing_samples','rated_completions','reviewed_completions','photos_planned','photos_processed','unreadable_photos','matches_shown','average_setup_ms','average_processing_ms','average_presentation_ms','average_photos_per_wall_second','p95_search_ms','completion_rate','rating_coverage','review_coverage','readable_photo_rate','processed_photo_rate','event_sample_size','legacy_event_sample_size'];
  schemas.RelatedMetrics=object({schemaVersion:{type:'integer',enum:[2]},cohort:{type:'string'},deliveryPrecision:{type:'string'},
    ...Object.fromEntries(relatedNumbers.map(name=>[name,numeric()])),
    sessions:object({started:numeric(false),ended:numeric(false),without_observed_end:numeric(false),average_duration_ms:numeric()}),
    delivery:object({sample_size:numeric(false),average_delay_ms:numeric(),p95_delay_ms:numeric(),events_retried:numeric(false),average_attempts_before_acceptance:numeric()}),
    platform_versions:{type:'array',nullable:true,items:object({platform:{type:'string',enum:['ios','android']},app_version:{type:'string'},searches_started:numeric(false),searches_completed:numeric(false),average_duration_ms:numeric(),subjective_rating_average:numeric(),rating_samples:numeric(false)})},
    rating_by_duration:{type:'array',nullable:true,items:object({stars:{type:'integer',minimum:1,maximum:5},searches:numeric(false),average_duration_ms:numeric()})},
  });
  schemas.Metrics = object({
    from:{type:'string',format:'date-time'},to:{type:'string',format:'date-time'},
    ...Object.fromEntries(metricFields.map(name=>[name,{type:'number',nullable:true,description:name.startsWith('subjective')?'Valoración subjetiva del usuario, no precisión técnica.':'null significa sin datos/denominador.'} as SchemaObject])),
    subjective_rating_distribution:{type:'object',nullable:true,additionalProperties:{type:'integer',minimum:0}},
    event_counts:{type:'object',nullable:true,additionalProperties:{type:'integer',minimum:0}},
    related:ref('RelatedMetrics'),
  });
  schemas.HistoricalMetric = object({day:{type:'string',format:'date-time'},type:{type:'string',enum:[...eventTypes]},dimension:{type:'string',description:'events, duration_seconds:N, stars:N, confirmed, rejected, photos:R, matches:R o error:C.'},count:{type:'string',pattern:'^[0-9]+$',description:'bigint PostgreSQL serializado como string.'},total:{type:'string',description:'numeric PostgreSQL serializado como string.'}});
  return schemas;
}
export function setupSwagger(app: INestApplication, retentionDays: number) {
  const config = new DocumentBuilder().setTitle('Personas · API de analítica').setVersion('1.1.0')
    .setDescription('Analítica opcional sin imágenes ni datos biométricos. En Authorize, usa installationToken para registro/lotes/borrado y adminToken para reportes. Pega sólo el token, sin el prefijo Bearer. Genera tu token de instalación con node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))". Registra primero una instalación UUIDv4. ADMIN_TOKEN está en tu .env local; nunca va en Flutter. Los ejemplos contienen identificadores ficticios: usa un eventId nuevo para cada evento. Límite64KiB y 60peticiones/min; registro10/min.')
    .addBearerAuth({type:'http',scheme:'bearer',bearerFormat:'64 caracteres hexadecimales',description:'Credencial propia de la instalación (aleatoria256bits); reutiliza la misma al enviar o borrar.'},'installationToken')
    .addBearerAuth({type:'http',scheme:'bearer',description:'ADMIN_TOKEN del entorno del backend. Sólo reportes.'},'adminToken').build();
  const document = SwaggerModule.createDocument(app,config);
  document.components ??= {};
  document.components.schemas = {...document.components.schemas,...analyticsSchemas(retentionDays)};
  SwaggerModule.setup('docs',app,document,{jsonDocumentUrl:'docs-json',swaggerOptions:{persistAuthorization:false,validatorUrl:null,displayRequestDuration:true},customSiteTitle:'Personas · Swagger'});
}
