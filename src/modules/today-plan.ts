import type { ModuleId, SessionRecord } from '../core/db';

/**
 * План на день: короткая назначенная тренировка из уже существующих
 * модулей. Новых режимов здесь нет и не появляется — задача плана только
 * в том, чтобы связать имеющиеся в цепочку «тренировка → измерение →
 * прогресс» и снять с ученика вопрос «а что мне сегодня делать».
 *
 * Модуль намеренно чистый: ни DOM, ни базы. Всё состояние приходит
 * снаружи (дата и сессии за день), поэтому поведение проверяется тестами.
 */

export interface PlanStep {
  module: ModuleId;
  label: string;
  /** Что именно делать — коротко, языком самого модуля. */
  detail: string;
  /** Вкладка, куда ведёт шаг. */
  tab: string;
}

export interface PlanStepState extends PlanStep {
  done: boolean;
}

export interface DayPlan {
  /** Локальная дата плана в виде YYYY-MM-DD. */
  day: string;
  steps: PlanStepState[];
  doneCount: number;
  /** Первый невыполненный шаг, либо null — на сегодня всё. */
  next: PlanStepState | null;
}

/** Разминка и реакция каждый день, третий шаг чередуется по дням. */
const WARMUP: PlanStep = {
  module: 'motorics',
  label: 'Моторика',
  detail: 'Разминка: 30 повторов на точность попадания по клетке',
  tab: 'motorics',
};

const CORE: PlanStep = {
  module: 'reaction',
  label: 'Реакция',
  detail: 'Скорость решения: серия заданий на время',
  tab: 'reaction',
};

const ROTATION: PlanStep[] = [
  {
    module: 'premove',
    label: 'Premove',
    detail: 'Заготовка ответа: форсированное взятие',
    tab: 'premove',
  },
  {
    module: 'openings',
    label: 'Дебюты',
    detail: 'Репертуар без заминок на знакомых узлах',
    tab: 'openings',
  },
  {
    module: 'scramble',
    label: 'Цейтнот',
    detail: 'Партия на флажке против бота',
    tab: 'scramble',
  },
];

/** Локальная дата как YYYY-MM-DD. UTC не годится: день должен совпадать
 *  с днём ученика, а не с гринвичским. */
export function dayKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Номер дня от эпохи — по нему и чередуем третий шаг. */
function dayIndex(at: Date): number {
  return Math.floor(new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() / 86_400_000);
}

/** Состав тренировки на конкретный день. Один и тот же день — один и тот
 *  же состав: план назначен, а не выпадает случайно при каждом заходе. */
export function planFor(at: Date): PlanStep[] {
  const third = ROTATION[((dayIndex(at) % ROTATION.length) + ROTATION.length) % ROTATION.length];
  return [WARMUP, CORE, third];
}

/** Сессия засчитывается за сегодня, если она в этот день и доведена до
 *  конца (endedAt проставляется только при завершении). */
export function sessionCountsToday(s: SessionRecord, at: Date): boolean {
  if (s.endedAt === null) return false;
  return dayKey(new Date(s.startedAt)) === dayKey(at);
}

/**
 * План с отметками выполнения. Выполненность берётся из записанных
 * замеров, а не из отдельного «чекбокса»: галочка появляется ровно тогда,
 * когда тренировка действительно измерена и попала в прогресс.
 */
export function buildDayPlan(sessions: SessionRecord[], at: Date): DayPlan {
  const todayModules = new Set(
    sessions.filter((s) => sessionCountsToday(s, at)).map((s) => s.module),
  );
  const steps: PlanStepState[] = planFor(at).map((s) => ({ ...s, done: todayModules.has(s.module) }));
  return {
    day: dayKey(at),
    steps,
    doneCount: steps.filter((s) => s.done).length,
    next: steps.find((s) => !s.done) ?? null,
  };
}
