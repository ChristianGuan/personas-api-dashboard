import {Pool} from 'pg';
import {config} from './config';
import {PostgresAnalytics} from './postgres';
const cfg=config(); const pool=new Pool({connectionString:cfg.databaseUrl});
new PostgresAnalytics(pool,cfg.retention).retain().then(()=>console.info('Retention completed.')).catch(()=>{console.error('Retention failed.');process.exitCode=1;}).finally(()=>pool.end());
