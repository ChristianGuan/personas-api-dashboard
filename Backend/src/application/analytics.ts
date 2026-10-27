import { AnalyticsEvent, AnalyticsRepository } from '../domain/analytics';
export class Analytics {
  constructor(private readonly repository: AnalyticsRepository) {}
  register(id: string, hash: string) { return this.repository.register(id, hash); }
  async batch(id: string, hash: string, events: AnalyticsEvent[]) {
    return { acceptedEventIds: await this.repository.ingest(id, hash, events) };
  }
  remove(id: string, hash: string) { return this.repository.remove(id, hash); }
  async metrics(from: Date, to: Date) { await this.repository.retain(); return this.repository.metrics(from, to); }
  async history() { await this.repository.retain(); return this.repository.history(); }
}
