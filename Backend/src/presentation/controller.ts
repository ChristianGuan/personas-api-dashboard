import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody, ApiOkResponse, ApiResponse, ApiQuery, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Analytics } from '../application/analytics';
import { batchSchema, eventSchema, periodSchema, registrationSchema, uuid } from './validation';
import { config } from '../infrastructure/config';
function hash(auth?: string) {
  if (!auth || !/^Bearer [a-f0-9]{64}$/.test(auth)) throw new UnauthorizedException();
  return createHash('sha256').update(auth.slice(7)).digest('hex');
}
function admin(auth?: string) {
  const actual = createHash('sha256').update(auth ?? '').digest();
  const expected = createHash('sha256').update(`Bearer ${config().adminToken}`).digest();
  if (!timingSafeEqual(actual, expected)) throw new UnauthorizedException();
}
@ApiTags('Analítica')
@ApiResponse({status:400,description:'Envelope, parámetros o tipos inválidos.',schema:{$ref:'#/components/schemas/Error'}})
@ApiResponse({status:401,description:'Credencial ausente, incorrecta o instalación revocada.',schema:{$ref:'#/components/schemas/Error'}})
@ApiResponse({status:413,description:'Cuerpo JSON supera64KiB.',schema:{$ref:'#/components/schemas/Error'}})
@ApiResponse({status:429,description:'Límite de peticiones alcanzado.',schema:{$ref:'#/components/schemas/Error'}})
@ApiResponse({status:500,description:'Error interno; lote revertido si falla la transacción.',schema:{$ref:'#/components/schemas/Error'}})
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(@Inject(Analytics) private readonly analytics: Analytics) {}
  @ApiBearerAuth('installationToken')
  @ApiOperation({summary:'Registrar una instalación',description:'Idempotente con el mismo UUIDv4 y credencial. Sólo después de consentimiento. Una instalación eliminada no puede registrarse de nuevo.'})
  @ApiBody({schema:{$ref:'#/components/schemas/Registration'},examples:{installation:{value:{installationId:'11111111-1111-4111-8111-111111111111'}}}})
  @ApiOkResponse({schema:{$ref:'#/components/schemas/Registered'}})
  @Post('installations') @HttpCode(200) @Throttle({default: {limit:10,ttl:60000}})
  async register(@Body() body: unknown,@Headers('authorization') auth?: string) {
    const p=registrationSchema.safeParse(body); if (!p.success) throw new BadRequestException();
    await this.analytics.register(p.data.installationId,hash(auth)); return {registered:true};
  }
  @ApiBearerAuth('installationToken')
  @ApiOperation({summary:'Enviar un lote de eventos',description:'Máximo50. Los índices inválidos se rechazan individualmente; sólo acceptedEventIds confirma almacenamiento. Un reenvío idéntico se deduplica; colisiones con contenido diferente no se aceptan. Cada payload admite exclusivamente sus campos documentados.'})
  @ApiBody({schema:{$ref:'#/components/schemas/Batch'},examples:{session:{summary:'Sesión iniciada',value:{installationId:'11111111-1111-4111-8111-111111111111',events:[{eventId:'22222222-2222-4222-8222-222222222222',installationId:'11111111-1111-4111-8111-111111111111',type:'session_started',schemaVersion:1,createdAt:new Date().toISOString(),payload:{}}]}}}})
  @ApiOkResponse({schema:{$ref:'#/components/schemas/BatchAck'}})
  @Post('events/batch') @HttpCode(200)
  async batch(@Body() body: unknown,@Headers('authorization') auth?: string) {
    const p=batchSchema.safeParse(body); if (!p.success) throw new BadRequestException();
    const schema=eventSchema(config().retention); const events=[]; const rejectedIndices:number[]=[];
    for (const [index,item] of p.data.events.entries()) {
      const e=schema.safeParse(item);
      if (!e.success || e.data.installationId!==p.data.installationId) rejectedIndices.push(index); else events.push(e.data);
    }
    const response=await this.analytics.batch(p.data.installationId,hash(auth),events);
    return {...response,rejectedIndices};
  }
  @ApiBearerAuth('installationToken')
  @ApiOperation({summary:'Eliminar los eventos de la instalación',description:'Exige la credencial propia, no basta el UUID público. Borrado idempotente y tombstone30d; no elimina agregados ya anónimos.'})
  @ApiParam({name:'id',format:'uuid',description:'UUIDv4 de la instalación que posee el token.'})
  @ApiOkResponse({schema:{$ref:'#/components/schemas/Deleted'}})
  @Delete('installations/:id') @HttpCode(200)
  async remove(@Param('id') id: string,@Headers('authorization') auth?: string) {
    if (!uuid.safeParse(id).success) throw new BadRequestException();
    await this.analytics.remove(id,hash(auth)); return {deleted:true};
  }
  @ApiBearerAuth('adminToken')
  @ApiOperation({summary:'Consultar métricas recientes',description:'Sólo administración. Ventana [from,to) dentro de RETENTION_DAYS, to<=ahora+5min. Tasas en fracción; null significa sin datos. Estrellas son valoración subjetiva; confirmadas son evaluaciones del usuario. No son precisión técnica ni usuarios únicos.'})
  @ApiQuery({name:'from',type:String,format:'date-time',example:new Date(Date.now()-86400000).toISOString()})
  @ApiQuery({name:'to',type:String,format:'date-time',example:new Date().toISOString()})
  @ApiOkResponse({schema:{$ref:'#/components/schemas/Metrics'}})
  @Get('metrics')
  async metrics(@Query() query: unknown,@Headers('authorization') auth?: string) {
    admin(auth); const p=periodSchema.safeParse(query); if (!p.success) throw new BadRequestException();
    const from=new Date(p.data.from),to=new Date(p.data.to), now=Date.now();
    if (+from>=+to || +from<now-config().retention*86400000 || +to>now+300000) throw new BadRequestException();
    return this.analytics.metrics(from,to);
  }
  @ApiBearerAuth('adminToken')
  @ApiOperation({summary:'Consultar agregados históricos anónimos',description:'Sólo administración. Hasta10000 filas por fecha descendente. No permite reconstruir instalaciones únicas tras la retención.'})
  @ApiOkResponse({schema:{type:'array',items:{$ref:'#/components/schemas/HistoricalMetric'}}})
  @Get('history') async history(@Headers('authorization') auth?: string) {admin(auth);return this.analytics.history();}
}
