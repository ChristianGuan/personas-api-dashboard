import 'reflect-metadata';
import { Module, Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { json } from 'express';
import { Pool } from 'pg';
import { Analytics } from './application/analytics';
import { AccessDenied } from './domain/analytics';
import { PostgresAnalytics } from './infrastructure/postgres';
import { AnalyticsController } from './presentation/controller';
import { config } from './infrastructure/config';
import { setupSwagger } from './presentation/swagger';
@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown,host: ArgumentsHost) {
    const status=error instanceof AccessDenied?401:error instanceof HttpException?error.getStatus():500;
    host.switchToHttp().getResponse().status(status).json({error: status===500?'Internal error':'Request rejected'});
  }
}
async function bootstrap() {
  const cfg=config(); const pool=new Pool({connectionString:cfg.databaseUrl,max:10,connectionTimeoutMillis:5000,statement_timeout:10000});
  pool.on('error',()=>console.error('Database connection unavailable.'));
  const repo=new PostgresAnalytics(pool,cfg.retention);
  await repo.retain();
  @Module({imports:[ThrottlerModule.forRoot([{ttl:60000,limit:60}])],controllers:[AnalyticsController],providers:[{provide:Analytics,useValue:new Analytics(repo)},{provide:APP_GUARD,useClass:ThrottlerGuard}]})
  class AppModule {}
  const app=await NestFactory.create(AppModule,{bodyParser:false,logger:false});
  app.use(json({limit:'64kb',strict:true})); app.useGlobalFilters(new SafeErrors());
  // Express parser errors occur outside Nest's filter. Do not return its body/error details.
  app.use((error: any,_req: any,res: any,_next: any)=>res.status(error?.status===413?413:400).json({error:'Request rejected'}));
  setupSwagger(app,cfg.retention);
  const timer=setInterval(()=>void repo.retain().catch(()=>console.error('Retention failed.')),3600000);timer.unref();
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>void (async()=>{clearInterval(timer);await app.close();await pool.end();})());
  await app.listen(cfg.port,cfg.host);console.info(`Analytics API listening on port ${cfg.port}.`);
}
bootstrap().catch(()=>{console.error('Startup failed. Check configuration and run migrations.');process.exitCode=1;});
