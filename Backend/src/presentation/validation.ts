import { z } from 'zod';
import { eventTypes } from '../domain/analytics';
export const uuid = z.uuidv4();
const ms = z.number().int().min(0).max(86400000);
export const count = z.number().int().min(0).max(1000000);
const range = z.enum(['0', '1-25', '26-100', '101-500', '501+']);
export const payloads = {
  session_started: z.strictObject({}), session_ended: z.strictObject({durationMs: ms}),
  search_started: z.strictObject({}),
  search_completed: z.strictObject({durationMs: ms, photoRange: range, matchRange: range}),
  search_cancelled: z.strictObject({durationMs: ms, photoRange: range}),
  search_failed: z.strictObject({durationMs: ms, errorCategory: z.enum(['permission', 'storage', 'processing', 'unknown'])}),
  results_rated: z.strictObject({stars: z.number().int().min(1).max(5)}),
  results_reviewed: z.strictObject({confirmed: count, rejected: count}).refine(p => p.confirmed + p.rejected > 0),
};
const session = {sessionId: uuid};
const search = {...session, searchId: uuid};
const counts = {photosPlanned: count, photosProcessed: count, unreadableCount: count, matchesShown: count};
const timing = {durationMs: ms, setupMs: ms, processingMs: ms};
export const diagnosticFields = {readMs:ms.optional(),decodeMs:ms.optional(),engineMs:ms.optional(),cacheHits:count.optional(),cacheMisses:count.optional(),cancelLatencyMs:ms.optional(),timeToCancelMs:ms.optional()};
const end = {...diagnosticFields,...search,...counts,timingSource:z.enum(['live','unavailable']),durationMs:ms.optional(),setupMs:ms.optional(),processingMs:ms.optional()};
const consistent = (p: Record<string, unknown>) => (!(p.cacheHits!==undefined || p.cacheMisses!==undefined) || (p.cacheHits!==undefined && p.cacheMisses!==undefined && Number(p.cacheHits)+Number(p.cacheMisses)<=Number(p.photosProcessed))) && Number(p.photosProcessed)<=Number(p.photosPlanned) && Number(p.unreadableCount)+Number(p.matchesShown)<=Number(p.photosProcessed) && (p.timingSource==='unavailable' ? p.durationMs===undefined && p.setupMs===undefined && p.processingMs===undefined : p.durationMs!==undefined && p.setupMs!==undefined && p.processingMs!==undefined && Number(p.setupMs)+Number(p.processingMs)<=Number(p.durationMs));
export const payloadsV2 = {
  session_started:z.strictObject(session), session_ended:z.strictObject({...session,durationMs:ms}),
  search_started:z.strictObject({...search,photosPlanned:count}),
  search_completed:z.strictObject(end).refine(consistent),
  search_cancelled:z.strictObject(end).refine(consistent),
  search_failed:z.strictObject({...end,errorCategory:z.enum(['permission','storage','processing','unknown'])}).refine(consistent),
  search_interrupted:z.strictObject({...search,photosPlanned:count,errorCategory:z.literal('process_interrupted')}),
  results_rated:z.strictObject({...search,stars:z.number().int().min(1).max(5)}),
  results_reviewed:z.strictObject({...search,confirmed:count,rejected:count}).refine(p=>p.confirmed+p.rejected>0),
  results_presented:z.strictObject({...search,presentationMs:ms}),
};
export const appVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}\+\d{1,10}$/);
export function eventSchema(retentionDays = 30, now = Date.now()) {
  return z.strictObject({
    eventId:uuid,installationId:uuid,type:z.enum(eventTypes),schemaVersion:z.union([z.literal(1),z.literal(2)]),
    createdAt:z.iso.datetime({offset:true}).refine(v=>Date.parse(v)>=now-retentionDays*86400000 && Date.parse(v)<=now+300000),
    payload:z.record(z.string(),z.union([z.string(),z.number()])),
    platform:z.enum(['android','ios']).optional(),appVersion:appVersion.optional(),deliveryAttempts:count.optional(),
  }).superRefine((e,ctx)=>{
    const schema = e.schemaVersion===1 ? payloads[e.type as keyof typeof payloads] : payloadsV2[e.type];
    if (!schema?.safeParse(e.payload).success || (e.schemaVersion===1 && (e.platform!==undefined || e.appVersion!==undefined)) || (e.schemaVersion===2 && (!e.platform || !e.appVersion))) ctx.addIssue({code:'custom',message:'Invalid versioned analytics event'});
  });
}
export const registrationSchema = z.strictObject({installationId: uuid});
export const batchSchema = z.strictObject({installationId: uuid, events: z.array(z.unknown()).min(1).max(50)});
export const periodSchema = z.strictObject({from: z.iso.datetime({offset: true}), to: z.iso.datetime({offset: true})});
