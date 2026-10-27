export const eventTypes = ['session_started', 'session_ended', 'search_started', 'search_completed', 'search_cancelled', 'search_failed', 'results_rated', 'results_reviewed', 'search_interrupted', 'results_presented'] as const;
export interface AnalyticsEvent {
  eventId: string; installationId: string; type: typeof eventTypes[number];
  schemaVersion: 1 | 2; platform?: 'android' | 'ios'; appVersion?: string; deliveryAttempts?: number; createdAt: string; payload: Record<string, string | number>;
}
export class AccessDenied extends Error {}
export interface AnalyticsRepository {
  register(id: string, tokenHash: string): Promise<void>;
  ingest(id: string, tokenHash: string, events: AnalyticsEvent[]): Promise<string[]>;
  remove(id: string, tokenHash: string): Promise<void>;
  metrics(from: Date, to: Date): Promise<Record<string, unknown>>;
  history(): Promise<unknown[]>;
  retain(): Promise<void>;
}
