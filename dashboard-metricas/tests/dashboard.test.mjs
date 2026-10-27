import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const real=JSON.parse(await readFile(new URL('./fixtures/empty.json',import.meta.url),'utf8'));
function setup(data){
 const elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{value:id==='period'?'30':['outcome','version','batch'].includes(id)?'all':'',innerHTML:'',textContent:'',setAttribute(){},scrollIntoView(){},classList:{toggle(){}}});return elements.get(id);};
 const platforms=['all','ios','android'].map(platform=>({dataset:{platform},classList:{toggle(){}}}));
 const ctx=vm.createContext({document:{getElementById:el,querySelectorAll:s=>s==='[data-platform]'?platforms:[],createElement:()=>({click(){}})},location:{hostname:'localhost'},fetch:async()=>({ok:true,json:async()=>data}),URL,Blob,AbortSignal,console});
 vm.runInContext(source,ctx);
 return {el,ctx,platforms};
}
test('filters terminal outcomes, versions and batch sizes without counting unknown photos as measured',async()=>{
 const date=real.updatedAt;
 const searches=[{date,platform:'ios',version:'0.9.2+15',outcome:'search_completed',planned:100,photos:100,processing_ms:1000,cache_hits:100,cache_misses:0},{date,platform:'android',version:'0.9.2+15',outcome:'search_cancelled',planned:200,photos:20,processing_ms:1000,cancel_latency_ms:40},{date,platform:'ios',version:'0.9.1+14',outcome:'without_observed_end',planned:50,photos:null,processing_ms:null}];
 const {el,platforms}=setup({...real,searches});await new Promise(r=>setImmediate(r));
 assert.match(el('row-count').textContent,/3/);assert.match(el('cards').innerHTML,/60/);
 el('outcome').value='search_cancelled';el('outcome').onchange();assert.match(el('row-count').textContent,/1/);assert.match(el('runs').innerHTML,/Cancelada/);assert.match(el('cancellations').innerHTML,/0,04 s/);
 el('outcome').value='all';el('version').value='0.9.1+14';el('version').onchange();assert.match(el('cards').innerHTML,/—/);assert.match(el('runs').innerHTML,/Sin final observado/);
 el('version').value='all';el('batch').value='101-500';el('batch').onchange();assert.match(el('row-count').textContent,/1/);
 platforms[1].onclick();assert.match(el('row-count').textContent,/0/);assert.match(el('runs').innerHTML,/Sin ejecuciones/);
});
test('execution details keep absent measurements unknown and escape text',async()=>{
 const {el,ctx}=setup(real);await new Promise(r=>setImmediate(r));
 ctx.record={date:real.updatedAt,platform:'ios',version:'<script>',outcome:'search_cancelled',planned:100,photos:20,processing_ms:1000,cache_hits:null,error_category:'<img>'};
 vm.runInContext('showRun(record)',ctx);
 assert.match(el('run-detail').innerHTML,/&lt;script&gt;/);assert.match(el('run-detail').innerHTML,/&lt;img&gt;/);assert.match(el('run-detail').innerHTML,/No representa cero/);
});
