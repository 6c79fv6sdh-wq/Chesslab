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
  label: 'Тактика',
  detail: 'Скорость решения: серия заданий на время',
  tab: 'reaction',
};

const ROTATION: PlanStep[] = [
  {
    module: 'premove',
    label: 'Премувы',
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
    label: 'Спарринг',
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
 *  конца (endedAt проставляется только при завершении). Не требует
 *  ПОЛНОГО прохождения — для этого есть sessionIsComplete ниже. Этой,
 *  более мягкой проверкой считается «Итог дня»: сколько всего заданий
 *  сделано и сколько времени потрачено, включая прерванные попытки. */
export function sessionCountsToday(s: SessionRecord, at: Date): boolean {
  if (s.endedAt === null) return false;
  return dayKey(new Date(s.startedAt)) === dayKey(at);
}

/**
 * Пороги полноценного завершения сессии по модулям. Дублируют константы
 * из своих модулей (`REPS` в motorics.ts, `TASKS_PER_SESSION` в
 * premove.ts и reaction.ts, `LINES_PER_SESSION` в openings.ts) —
 * намеренно, а не импортом: те же модули импортируют stepAfter() ниже
 * для кнопки «Следующее упражнение», и обратный импорт констант отсюда
 * дал бы цикл между today-plan.ts и каждым из пяти модулей. Совпадение
 * значений с оригиналом проверяет tests/today-plan.test.ts.
 */
const MOTORICS_REPS = 30;
const PREMOVE_TASKS = 8;
const REACTION_TASKS = 10;
const OPENINGS_LINES = 4;

/**
 * Модуль засчитан за день только при полноценном завершении сессии — не
 * при любом её закрытии. «Прервать» и уход с вкладки тоже вызывают
 * session.finish() (иначе замер потерялся бы), поэтому полноценность
 * проверяем по факту: сколько заданий/линий/повторов реально сделано, а
 * для Цейтнота — не была ли партия сдана досрочно.
 */
export function sessionIsComplete(s: SessionRecord): boolean {
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  switch (s.module) {
    case 'motorics':
      return num(s.summary.reps) === MOTORICS_REPS;
    case 'premove':
      return num(s.summary.attempts) === PREMOVE_TASKS;
    case 'reaction':
      return num(s.summary.attempts) === REACTION_TASKS;
    case 'openings':
      return num(s.summary.linesDone) === OPENINGS_LINES;
    case 'scramble':
      return typeof s.summary.outcome === 'string' && s.summary.outcome !== 'aborted';
  }
}

/**
 * План с отметками выполнения. Выполненность берётся из записанных
 * замеров, а не из отдельного «чекбокса»: галочка появляется ровно тогда,
 * когда тренировка действительно измерена, полностью пройдена и попала
 * в прогресс.
 */
export function buildDayPlan(sessions: SessionRecord[], at: Date): DayPlan {
  const todayModules = new Set(
    sessions.filter((s) => sessionCountsToday(s, at) && sessionIsComplete(s)).map((s) => s.module),
  );
  const steps: PlanStepState[] = planFor(at).map((s) => ({ ...s, done: todayModules.has(s.module) }));
  return {
    day: dayKey(at),
    steps,
    doneCount: steps.filter((s) => s.done).length,
    next: steps.find((s) => !s.done) ?? null,
  };
}

/**
 * Следующий шаг ПОСЛЕ данного модуля в сегодняшнем плане — чисто по
 * позиции в плане дня, для кнопки «Следующее упражнение →». Не зависит
 * от того, пройден ли текущий шаг: пользователь мог прерваться и всё
 * равно решить идти дальше, вернуться к пропущенному можно с «Сегодня».
 * `null` — шаг последний (или вообще не из сегодняшнего плана).
 */
export function stepAfter(current: ModuleId, at: Date): PlanStep | null {
  const plan = planFor(at);
  const idx = plan.findIndex((s) => s.module === current);
  if (idx === -1) return null;
  return plan[idx + 1] ?? null;
}
