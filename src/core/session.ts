import {
  type ModuleId,
  type MeasurementRecord,
  type SessionRecord,
  activeProfileId,
  putMeasurement,
  putSession,
  uid,
} from './db';
import type { Calibration } from './settings';

/**
 * Снимок калибровки для записи в замеры: boardSize подменяем на фактический
 * размер доски. В настройках это ЖЕЛАЕМЫЙ размер, но на телефоне доска
 * ужимается под ширину экрана — записав желаемый, мы бы в разбивке «по
 * размеру доски» складывали замеры с 480 px монитора и с 336 px телефона
 * в одну строку «480 px».
 */
export function measuredCalibration(cal: Calibration, boardSize: number): Calibration {
  return { ...cal, boardSize };
}

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

  /**
   * Владелец записей. Читается из базы при первом обращении: сессия
   * создаётся в разных модулях, и таскать профиль через каждый
   * конструктор — лишний параметр в десяти местах ради одного и того же
   * значения.
   */
  private ownerPromise: Promise<string | null> | null = null;

  private owner(): Promise<string | null> {
    if (!this.ownerPromise) this.ownerPromise = activeProfileId();
    return this.ownerPromise;
  }

  async record(data: Record<string, unknown>): Promise<void> {
    const profileId = (await this.owner()) ?? undefined;
    const rec: MeasurementRecord = {
      id: uid(),
      sessionId: this.id,
      module: this.module,
      mode: this.mode,
      ts: Date.now(),
      calibration: this.calibration,
      data,
      profileId,
    };
    this.count++;
    await putMeasurement(rec);
  }

  async finish(summary: Record<string, number | string | null>): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const profileId = (await this.owner()) ?? undefined;
    const rec: SessionRecord = {
      id: this.id,
      module: this.module,
      mode: this.mode,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      calibration: this.calibration,
      summary,
      profileId,
    };
    await putSession(rec);
  }
}

const PLAN_NAV_KEY = 'sciencechess-lab-plan-nav';

/**
 * Флаг «идём по плану „Сегодня“» — межстраничный, но одноразовый.
 * Ставится перед переходом на вкладку модуля из «Сегодня» (кнопки
 * «Начать тренировку», «Перейти», «Повторить»), а модуль на входе сам
 * его считывает и снимает (см. consumePlanNavigation). Так кнопка
 * «Следующее упражнение →» после сессии показывается только тем, кто
 * реально пришёл из дневного плана, а не всем, кто открыл вкладку
 * напрямую через меню, — и не остаётся висеть навсегда после одного
 * случайного захода.
 */
export function markPlanNavigation(): void {
  try {
    sessionStorage.setItem(PLAN_NAV_KEY, '1');
  } catch {
    // Приватный режим/заблокированный sessionStorage — просто не будет
    // кнопки «Следующее упражнение», сама тренировка не пострадает.
  }
}

/** Пришли ли на этот экран из дневного плана. Снимает флаг при чтении. */
export function consumePlanNavigation(): boolean {
  try {
    const v = sessionStorage.getItem(PLAN_NAV_KEY) === '1';
    sessionStorage.removeItem(PLAN_NAV_KEY);
    return v;
  } catch {
    return false;
  }
}
