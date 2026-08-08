import {
  type ModuleId,
  type MeasurementRecord,
  type SessionRecord,
  putMeasurement,
  putSession,
  uid,
} from './db';
import type { Calibration } from './settings';

/**
 * Обёртка сессии упражнения. Каждый замер получает снимок калибровки,
 * действовавшей на момент старта сессии.
 */
export class Session {
  readonly id = uid();
  readonly startedAt = Date.now();
  private ended = false;
  private count = 0;

  constructor(
    readonly module: ModuleId,
    readonly mode: string,
    readonly calibration: Calibration,
  ) {}

  get measurementCount(): number {
    return this.count;
  }

  async record(data: Record<string, unknown>): Promise<void> {
    const rec: MeasurementRecord = {
      id: uid(),
      sessionId: this.id,
      module: this.module,
      mode: this.mode,
      ts: Date.now(),
      calibration: this.calibration,
      data,
    };
    this.count++;
    await putMeasurement(rec);
  }

  async finish(summary: Record<string, number | string | null>): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const rec: SessionRecord = {
      id: this.id,
      module: this.module,
      mode: this.mode,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      calibration: this.calibration,
      summary,
    };
    await putSession(rec);
  }
}
