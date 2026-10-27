import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eventSchema,batchSchema} from '../src/presentation/validation';
const event={eventId:randomUUID(),installationId:randomUUID(),type:'search_completed',schemaVersion:1,createdAt:new Date().toISOString(),payload:{durationMs:1000,photoRange:'1-25',matchRange:'0'}};
test('closed schemas reject private fields, wrong ranges and old events',()=>{
 assert(eventSchema().safeParse(event).success);
 for(const payload of [{...event.payload,album:'private'}, {...event.payload,photoRange:'100'}, {...event.payload,durationMs:-1}, {...event.payload,durationMs:1.2}]) assert(!eventSchema().safeParse({...event,payload}).success);
 assert(!eventSchema().safeParse({...event,photoUri:'content://private'}).success);
 assert(!eventSchema().safeParse({...event,createdAt:new Date(Date.now()-31*86400000).toISOString()}).success);
 assert(!eventSchema().safeParse({...event,createdAt:new Date(Date.now()+600000).toISOString()}).success);
 assert(!batchSchema.safeParse({installationId:event.installationId,events:Array(51).fill(event)}).success);
 assert(!eventSchema().safeParse({...event,type:'results_rated',payload:{stars:0}}).success);
 assert(!eventSchema().safeParse({...event,type:'results_reviewed',payload:{confirmed:0,rejected:0}}).success);
});
