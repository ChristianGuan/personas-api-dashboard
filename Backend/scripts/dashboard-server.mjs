import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {dashboardData} from './dashboard-data.mjs';
const root=new URL('../../dashboard-metricas/dist/',import.meta.url);
if(process.argv.includes('--export')){await writeFile(new URL('data.json',root),JSON.stringify(await dashboardData()));console.log('Dashboard snapshot exported.');}
else createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/dashboard'){res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(await dashboardData()));return;}
 const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/data.json':'data.json'};
 const name=files[url.pathname];if(!name){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.json')?'application/json':'text/html');res.end(await readFile(new URL(name,root)));
 }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'No se pudieron cargar las métricas. Comprueba la API y PostgreSQL.'}));}
}).listen(Number(process.env.DASHBOARD_PORT ?? 3001),process.env.DASHBOARD_HOST ?? '127.0.0.1',()=>console.log(`Dashboard: http://${process.env.DASHBOARD_HOST ?? '127.0.0.1'}:${process.env.DASHBOARD_PORT ?? 3001}`));
