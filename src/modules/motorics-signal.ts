/**
 * «Сигнал» — Go/No-Go на реакцию и торможение, второе упражнение раздела
 * «Моторика». Модуль чистый (ни DOM, ни таймеров): всё, что можно решить
 * без побочных эффектов — планирование следующего стимула и разбор
 * исхода попытки — живёт здесь и проверяется тестами. Таймеры и рендер —
 * в motorics.ts, он же и держит состояние сессии.
 */

export type SignalColor = 'green' | 'blue' | 'purple' | 'amber' | 'red';

/** Целевой цвет — единственный, на который нужно реагировать. */
export const TARGET_COLOR: SignalColor = 'green';

/** Порядок = порядок в легенде, если она когда-нибудь понадобится. */
export const SIGNAL_COLORS: SignalColor[] = ['green', 'blue', 'purple', 'amber', 'red'];

const DISTRACTOR_COLORS: SignalColor[] = SIGNAL_COLORS.filter((c) => c !== TARGET_COLOR);

export interface SignalTimings {
  /** Случайная пауза перед стимулом, мс. */
  minGapMs: number;
  maxGapMs: number;
  /** Длительность самой вспышки, мс — визуал, не окно реакции. */
  showMs: number;
  /** Сколько времени даётся на клик после показа, мс. */
  reactionWindowMs: number;
  /** Доля целевых (зелёных) стимулов среди всех. */
  targetShare: number;
}

export const DEFAULT_SIGNAL_TIMINGS: SignalTimings = {
  minGapMs: 700,
  maxGapMs: 2200,
  showMs: 250,
  reactionWindowMs: 700,
  targetShare: 0.3,
};

/** Сколько стимулов в сессии. */
export const SIGNAL_TRIALS = 40;

export interface StimulusPlan {
  color: SignalColor;
  /** Пауза ПЕРЕД этим стимулом, мс — считается от предыдущего. */
  gapMs: number;
}

/**
 * Следующий стимул целиком. Готовится заранее (см. вызывающий код в
 * motorics.ts) — ничего не генерируется синхронно в момент показа,
 * поэтому появление сигнала не зависит от скорости какой-либо генерации.
 */
export function planNextStimulus(t: SignalTimings, rnd: () => number): StimulusPlan {
  const gapMs = t.minGapMs + rnd() * (t.maxGapMs - t.minGapMs);
  const color = rnd() < t.targetShare ? TARGET_COLOR : DISTRACTOR_COLORS[Math.floor(rnd() * DISTRACTOR_COLORS.length)];
  return { color, gapMs };
}

export type TrialOutcome = 'hit' | 'miss' | 'falseAlarm' | 'falseStart' | 'correctIgnore';

export interface TrialResult {
  index: number;
  /** null — falseStart: клик до какого-либо стимула, не привязан к цвету. */
  color: SignalColor | null;
  isTarget: boolean;
  outcome: TrialOutcome;
  /** signalShownAt → pointerDownAt. null, если реакции не было. */
  reactionMs: number | null;
}

/**
 * Разбор попытки во время активного окна стимула (клик пришёл, пока
 * стимул ещё «жив»). Не решает false start (клик до стимула) и не решает
 * miss/correctIgnore (реакции не было вовсе, окно истекло) — те у вызова
 * нет, они собираются напрямую в motorics.ts по таймауту.
 */
export function classifyReaction(
  index: number,
  color: SignalColor,
  shownAt: number,
  clickedAt: number,
): TrialResult {
  const isTarget = color === TARGET_COLOR;
  return {
    index,
    color,
    isTarget,
    outcome: isTarget ? 'hit' : 'falseAlarm',
    reactionMs: isTarget ? clickedAt - shownAt : null,
  };
}

/** Стимул не дождался реакции в своё окно — miss (цель) или correctIgnore (не цель). */
export function classifyTimeout(index: number, color: SignalColor): TrialResult {
  const isTarget = color === TARGET_COLOR;
  return {
    index,
    color,
    isTarget,
    outcome: isTarget ? 'miss' : 'correctIgnore',
    reactionMs: null,
  };
}

/** Клик пришёл, пока сигнала не было вообще (фаза ожидания). */
export function falseStart(index: number): TrialResult {
  return { index, color: null, isTarget: false, outcome: 'falseStart', reactionMs: null };
}

/** Успешные реакции — единственные записи с осмысленным временем. */
export function reactionTimes(trials: TrialResult[]): number[] {
  return trials
    .filter((t): t is TrialResult & { reactionMs: number } => t.outcome === 'hit' && t.reactionMs !== null)
    .map((t) => t.reactionMs);
}

export function countBy(trials: TrialResult[], outcome: TrialOutcome): number {
  return trials.filter((t) => t.outcome === outcome).length;
}

/**
 * Точность: доля верно обработанных предъявленных стимулов (hit +
 * correctIgnore) от их общего числа. False start в знаменатель не входит
 * — он не привязан ни к какому стимулу, это отдельная ошибка импульса,
 * а не пропущенный сигнал.
 */
export function accuracy(trials: TrialResult[]): number | null {
  const presented = trials.filter((t) => t.outcome !== 'falseStart');
  if (!presented.length) return null;
  const correct = presented.filter((t) => t.outcome === 'hit' || t.outcome === 'correctIgnore').length;
  return correct / presented.length;
}
