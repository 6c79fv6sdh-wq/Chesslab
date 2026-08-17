import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, metric, metrics, panel, segmented, statLine, table } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { fmtMs, fmtNum, fmtPct, fmtSec, groupBy, median, p90, plural } from '../core/stats';
import { directionBetween, squareDistance, type Direction } from '../core/chess';
import { measurementsOf } from '../core/db';
import { stepAfter } from './today-plan';
import {
  EMPTY_BOARD_FEN,
  boardRect,
  keyFromPoint,
  squareCenter,
  type PointerSample,
} from './motorics-geometry';
import {
  DEFAULT_SIGNAL_TIMINGS,
  SIGNAL_TRIALS,
  accuracy as signalAccuracy,
  classifyReaction,
  classifyTimeout,
  countBy as signalCountBy,
  falseStart as signalFalseStart,
  planNextStimulus,
  reactionTimes,
  type SignalColor,
  type StimulusPlan,
  type TrialResult,
} from './motorics-signal';

export const REPS = 30;

export interface RepResult {
  index: number;
  source: string;
  target: string;
  distance: number;
  direction: Direction;
  /** До первого движения указателя после появления цели, мс. */
  startLatencyMs: number | null;
  /** От показа исходной клетки до попадания по ней, мс. */
  toSourceMs: number;
  /** От клика по исходной до клика по целевой, мс. */
  sourceToTargetMs: number;
  totalMs: number;
  misses: number;
  /** Прямая / фактическая длина пути на отрезке источник→цель, 0..1. */
  pathEfficiency: number | null;
  /** Число коррекций у цели. */
  corrections: number;
}

/**
 * Эффективность траектории: отношение расстояния по прямой к фактически
 * пройденному пути. 1.0 — идеально прямое движение.
 */
export function pathEfficiency(samples: PointerSample[]): number | null {
  if (samples.length < 2) return null;
  let travelled = 0;
  for (let i = 1; i < samples.length; i++) {
    travelled += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  }
  if (travelled <= 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const straight = Math.hypot(last.x - first.x, last.y - first.y);
  return Math.min(1, straight / travelled);
}

/**
 * Коррекции у цели: сколько раз указатель, уже находясь вблизи цели,
 * снова начинал от неё удаляться. Классический признак «промазал и доводит».
 */
export function countCorrections(
  samples: PointerSample[],
  target: { x: number; y: number },
  radius: number,
): number {
  let corrections = 0;
  let approaching = true;
  let prevDist: number | null = null;
  for (const s of samples) {
    const d = Math.hypot(s.x - target.x, s.y - target.y);
    if (prevDist !== null && d > radius * 1.5) {
      // Далеко от цели — доводкой это не считаем.
      prevDist = d;
      approaching = true;
      continue;
    }
    if (prevDist !== null) {
      const movingAway = d > prevDist + 0.5;
      if (movingAway && approaching) {
        corrections++;
        approaching = false;
      } else if (!movingAway && d < prevDist - 0.5) {
        approaching = true;
      }
    }
    prevDist = d;
  }
  return corrections;
}

/** Пара клеток для повтора: случайная, но не совпадающая. */
export function randomPair(rnd: () => number): { source: string; target: string } {
  const key = () => {
    const f = Math.floor(rnd() * 8);
    const r = Math.floor(rnd() * 8);
    return String.fromCharCode(97 + f) + String(r + 1);
  };
  const source = key();
  let target = key();
  let guard = 0;
  while (target === source && guard++ < 50) target = key();
  return { source, target };
}

type Phase = 'idle' | 'to-source' | 'to-target' | 'done';

/** Какое из упражнений раздела сейчас на экране. */
type Exercise = 'click' | 'signal';

/**
 * Цвета сигнала: [ядро, тело, глубина] — три тона на цвет вместо двух,
 * чтобы вспышка читалась слоем света, а не заливкой. Ядро — яркая точка
 * в центре, тело — основной цвет свечения, глубина — тёмный тон по
 * краю доски (см. .signal-overlay в board.css). Подобраны по примерно
 * равной воспринимаемой яркости тела (формула относительной яркости
 * sRGB), чтобы зелёный не бросался в глаза просто потому, что он
 * светлее остальных — различать его нужно по СМЫСЛУ (это цель).
 */
const SIGNAL_PALETTE: Record<SignalColor, [core: string, mid: string, deep: string]> = {
  green: ['#8ff5c6', '#1faf6b', '#0b4f32'],
  blue: ['#9ccbff', '#3a8cf5', '#123b85'],
  purple: ['#d9b8ff', '#a566f0', '#431f82'],
  amber: ['#ffdd9e', '#e08a12', '#6b3d05'],
  red: ['#ffc1ce', '#f15c77', '#6b1f30'],
};

export function mountMotorics(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  // Считываем сразу на маунте: если позже переключиться на другую
  // вкладку и вернуться отдельно, флаг уже не должен сработать.
  const cameFromPlan = consumePlanNavigation();

  root.append(el('h1', {}, ['Моторика']));

  const boardHost = el('div', { class: 'board-host' });
  const trace = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  trace.setAttribute('class', 'hl-trace');

  const board = new Board(boardHost, {
    orientation: 'white',
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
    viewOnly: true,
    // Точки траектории считаются в пикселях доски, поэтому система
    // координат слоя обязана совпадать с её фактическим размером —
    // иначе на телефоне след рисовался бы со смещением и в другом масштабе.
    onResize: (size) => trace.setAttribute('viewBox', `0 0 ${size} ${size}`),
  });
  trace.setAttribute('viewBox', `0 0 ${board.size} ${board.size}`);
  board.setPosition({
    fen: EMPTY_BOARD_FEN,
    orientation: 'white',
    turnColor: 'white',
    viewOnly: true,
  });
  boardHost.append(trace);

  // Слой светового сигнала — смонтирован сразу и на весь срок жизни
  // экрана, независимо от того, какое упражнение выбрано сейчас: между
  // сигналами меняются только CSS-переменные и класс, а не сам узел.
  const signalOverlay = el('div', { class: 'signal-overlay' });
  boardHost.append(signalOverlay);

  function flashSignal(color: SignalColor, showMs: number): void {
    const [core, mid, deep] = SIGNAL_PALETTE[color];
    signalOverlay.style.setProperty('--signal-core', core);
    signalOverlay.style.setProperty('--signal-mid', mid);
    signalOverlay.style.setProperty('--signal-deep', deep);
    signalOverlay.style.setProperty('--signal-duration', `${showMs}ms`);
    // Перезапуск CSS-анимации с нуля: снять класс, форсировать reflow,
    // поставить обратно. Дешёвая операция, без нового узла и без layout
    // всей страницы — только для .signal-overlay (и его ::before, ядро
    // вспышки — тот же класс запускает обе анимации).
    signalOverlay.classList.remove('signal-pulse');
    void signalOverlay.offsetWidth;
    signalOverlay.classList.add('signal-pulse');
    // Доска — главный герой на миг вспышки: правая колонка чуть гаснет,
    // а не соревнуется за внимание. Только у «Сигнала» (side--signal) —
    // у «Клика» flashSignal вообще не вызывается.
    sideHost.classList.add('signal-live');
    window.setTimeout(() => sideHost.classList.remove('signal-live'), showMs);
  }

  function hideSignal(): void {
    signalOverlay.classList.remove('signal-pulse');
    sideHost.classList.remove('signal-live');
  }

  const promptEl = el('div', { class: 'prompt' }, ['Нажми «Старт».']);
  const progressBar = el('div', {});
  const progress = el('div', { class: 'progress' }, [progressBar]);
  const liveStats = el('div', {});
  const resultsHost = el('div', {});
  // Кнопка «Следующее упражнение» из дневного плана «Сегодня» — пусто вне
  // плана и очищается заново при каждом старте новой сессии.
  const planNextHost = el('div', { class: 'plan-next-host' });

  let phase: Phase = 'idle';
  let session: Session | null = null;
  let repIndex = 0;
  let source = '';
  let target = '';
  let stimulusAt = 0;
  let sourceHitAt = 0;
  let firstMoveAt: number | null = null;
  let misses = 0;
  // Границы сессии по настенным часам — для показателя «Общее время».
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let samples: PointerSample[] = [];
  const results: RepResult[] = [];

  const rnd = () => Math.random();

  function highlight(keys: Array<{ key: string; brush: string }>): void {
    board.api.setAutoShapes(keys.map((k) => ({ orig: k.key as never, brush: k.brush })));
  }

  function clearTrace(): void {
    while (trace.firstChild) trace.removeChild(trace.firstChild);
  }

  function drawTrace(): void {
    clearTrace();
    if (samples.length < 2) return;
    const rect = boardRect(board.wrap);
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute(
      'points',
      samples.map((s) => `${s.x - rect.left},${s.y - rect.top}`).join(' '),
    );
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--accent2)');
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-opacity', '0.85');
    trace.append(poly);
  }

  function nextRep(): void {
    if (repIndex >= REPS) {
      void finish();
      return;
    }
    const pair = randomPair(rnd);
    source = pair.source;
    target = pair.target;
    misses = 0;
    samples = [];
    firstMoveAt = null;
    clearTrace();
    phase = 'to-source';
    highlight([{ key: source, brush: 'green' }]);
    promptEl.textContent = `Повтор ${repIndex + 1} из ${REPS}: кликни по подсвеченной клетке ${source}.`;
    progressBar.style.width = `${(repIndex / REPS) * 100}%`;
    stimulusAt = performance.now();
  }

  function onPointerMove(e: PointerEvent): void {
    if (phase !== 'to-source' && phase !== 'to-target') return;
    const t = performance.now();
    if (firstMoveAt === null) firstMoveAt = t;
    if (phase === 'to-target') {
      samples.push({ x: e.clientX, y: e.clientY, t });
      drawTrace();
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (phase !== 'to-source' && phase !== 'to-target') return;
    const t = performance.now();
    const rect = boardRect(board.wrap);
    const key = keyFromPoint(e.clientX, e.clientY, rect, 'white');
    if (!key) return;

    if (phase === 'to-source') {
      if (key !== source) {
        misses++;
        return;
      }
      sourceHitAt = t;
      phase = 'to-target';
      samples = [{ x: e.clientX, y: e.clientY, t }];
      highlight([
        { key: source, brush: 'paleGrey' },
        { key: target, brush: 'green' },
      ]);
      promptEl.textContent = `Теперь клетка ${target}.`;
      return;
    }

    // phase === 'to-target'
    if (key !== target) {
      misses++;
      return;
    }
    samples.push({ x: e.clientX, y: e.clientY, t });
    drawTrace();
    completeRep(t);
  }

  function completeRep(t: number): void {
    const rect = boardRect(board.wrap);
    const targetCenter = squareCenter(target, rect, 'white');
    const rep: RepResult = {
      index: repIndex + 1,
      source,
      target,
      distance: squareDistance(source as never, target as never),
      direction: directionBetween(source as never, target as never),
      startLatencyMs: firstMoveAt === null ? null : firstMoveAt - stimulusAt,
      toSourceMs: sourceHitAt - stimulusAt,
      sourceToTargetMs: t - sourceHitAt,
      totalMs: t - stimulusAt,
      misses,
      pathEfficiency: pathEfficiency(samples),
      corrections: countCorrections(samples, targetCenter, rect.width / 8 / 2),
    };
    results.push(rep);
    repIndex++;
    void session?.record({ ...rep });
    renderLive();
    highlight([]);
    phase = 'idle';
    // Небольшая пауза, чтобы клик по цели не улетел в следующий повтор.
    window.setTimeout(() => {
      if (phase === 'idle' && session) nextRep();
    }, 350);
  }

  /**
   * Сколько идёт сессия. Пока она не закончена — считаем до «сейчас», после
   * — замораживаем на моменте финиша, иначе итог продолжал бы расти, пока
   * страница открыта.
   */
  function elapsedMs(): number | null {
    if (startedAt === null) return null;
    return (finishedAt ?? performance.now()) - startedAt;
  }

  /**
   * Три равноправных показателя, которые читают с одного взгляда, а под
   * ними — сухая расшифровка объёма. Раньше здесь строкой шли «Медиана
   * полного» и «P90 полного»: медиана осталась, но уже как «Скорость» и в
   * секундах (1,11 с понятнее, чем 1113 мс), а P90 виден только во
   * внутренних данных сессии — на экране он ничего не решал.
   */
  function renderLive(): void {
    const done = results.length;
    const totals = results.map((r) => r.totalMs);
    const hitRate = done ? results.filter((r) => r.misses === 0).length / done : null;
    const missCount = results.reduce((sum, r) => sum + r.misses, 0);

    liveStats.innerHTML = '';
    liveStats.append(
      metrics([
        metric('Скорость', fmtSec(median(totals))),
        metric('Без промахов', fmtPct(hitRate)),
        metric('Общее время', fmtSec(elapsedMs(), 1)),
      ]),
      el('p', { class: 'hint metrics-note' }, [
        `${done} ${plural(done, ['повтор', 'повтора', 'повторов'])} · ` +
          `${missCount} ${plural(missCount, ['промах', 'промаха', 'промахов'])}`,
      ]),
    );
    progressBar.style.width = `${(done / REPS) * 100}%`;
  }

  async function finish(): Promise<void> {
    phase = 'done';
    finishedAt = performance.now();
    highlight([]);
    promptEl.textContent = 'Сессия закончена. Результат записан.';
    // Заново, уже с замороженным «Общим временем».
    renderLive();
    const totals = results.map((r) => r.totalMs);
    await session?.finish({
      reps: results.length,
      medianTotalMs: median(totals),
      p90TotalMs: p90(totals),
      accuracy: results.length ? results.filter((r) => r.misses === 0).length / results.length : null,
    });
    session = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateExerciseLiveMark();
    renderBreakdown();
    renderPlanNext();
  }

  /**
   * Часть дневной тренировки «Сегодня» — ведём по цепочке дальше вместо
   * возврата в общий список вкладок. Показывается только тем, кто пришёл
   * сюда из плана (см. cameFromPlan); обычная самостоятельная тренировка
   * этой кнопки не увидит.
   */
  function renderPlanNext(): void {
    planNextHost.innerHTML = '';
    if (!cameFromPlan) return;
    const next = stepAfter('motorics', new Date());
    if (next) {
      const nextBtn = el('button', { class: 'btn primary plan-next', type: 'button' }, [
        `Следующее упражнение: ${next.label} →`,
      ]);
      nextBtn.addEventListener('click', () => {
        markPlanNavigation();
        location.hash = `#${next.tab}`;
      });
      planNextHost.append(nextBtn);
    } else {
      location.hash = '#today';
    }
  }

  function renderBreakdown(): void {
    resultsHost.innerHTML = '';
    if (!results.length) return;

    const byDistance = groupBy(results, (r) => r.distance);
    const distRows = [...byDistance.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, rs]) => [
        String(d),
        String(rs.length),
        fmtMs(median(rs.map((r) => r.sourceToTargetMs))),
        fmtMs(p90(rs.map((r) => r.sourceToTargetMs))),
        fmtNum(median(rs.map((r) => r.pathEfficiency ?? NaN)) ?? NaN, 2),
        fmtNum(median(rs.map((r) => r.corrections)) ?? NaN, 1),
      ]);

    const byDirection = groupBy(results, (r) => r.direction);
    const dirRows = [...byDirection.entries()].map(([d, rs]) => [
      d,
      String(rs.length),
      fmtMs(median(rs.map((r) => r.sourceToTargetMs))),
      fmtMs(p90(rs.map((r) => r.sourceToTargetMs))),
      fmtPct(rs.filter((r) => r.misses === 0).length / rs.length),
    ]);

    resultsHost.append(
      el('h3', {}, ['По расстоянию в клетках']),
      table(['Клеток', 'N', 'Медиана', 'P90', 'Эффект.', 'Коррекций'], distRows),
      el('h3', {}, ['По направлению']),
      table(['Направление', 'N', 'Медиана', 'P90', 'Без промахов'], dirRows),
    );
  }

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const stopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  stopBtn.disabled = true;

  startBtn.addEventListener('click', () => {
    results.length = 0;
    repIndex = 0;
    resultsHost.innerHTML = '';
    planNextHost.innerHTML = '';
    session = new Session('motorics', 'source-target', measuredCalibration(cal, board.size));
    startedAt = performance.now();
    finishedAt = null;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    updateExerciseLiveMark();
    renderLive();
    nextRep();
  });

  stopBtn.addEventListener('click', () => {
    if (session) void finish();
  });

  board.wrap.addEventListener('pointermove', onPointerMove);
  board.wrap.addEventListener('pointerdown', onPointerDown);

  /**
   * ---------------------------------------------------------------------
   * «Сигнал» — Go/No-Go на реакцию и торможение. Доска остаётся тёмной и
   * пустой (тот же board, что и у «Клика»), клик разрешён в любой её
   * точке — упражнение меряет реакцию и торможение, не наведение.
   *
   * Планирование стимулов — в motorics-signal.ts (чистое, без DOM и
   * таймеров, проверено тестами). Здесь только таймеры, рендер и запись
   * в сессию. Следующий стимул (sigNext) готовится в момент показа
   * текущего — его появление не ждёт никакой генерации «на лету».
   * ---------------------------------------------------------------------
   */

  type SignalPhase = 'idle' | 'waiting' | 'active' | 'done';

  let sigPhase: SignalPhase = 'idle';
  let sigSession: Session | null = null;
  let sigTrials: TrialResult[] = [];
  let sigTrialIndex = 0;
  let sigStreak = 0;
  let sigCurrent: StimulusPlan | null = null;
  let sigNext: StimulusPlan | null = null;
  let sigShownAt = 0;
  let sigResolved = false;
  let sigTimer: number | null = null;
  let sigPriorBestMs: number | null = null;

  const sigPromptEl = el('div', { class: 'prompt' }, ['Нажми «Старт».']);
  const sigProgressBar = el('div', {});
  const sigProgress = el('div', { class: 'progress' }, [sigProgressBar]);
  const sigLiveStats = el('div', {});
  const sigResultsHost = el('div', {});

  /** Личный рекорд среди уже сохранённых сессий — до старта этой. */
  async function historicalBestReactionMs(): Promise<number | null> {
    const all = await measurementsOf('motorics');
    const values = all
      .filter((m) => m.mode === 'signal' && m.data.outcome === 'hit')
      .map((m) => m.data.reactionMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return values.length ? Math.min(...values) : null;
  }

  function sigClearTimer(): void {
    if (sigTimer !== null) {
      window.clearTimeout(sigTimer);
      sigTimer = null;
    }
  }

  function sigRenderLive(): void {
    const hits = signalCountBy(sigTrials, 'hit');
    const errors =
      signalCountBy(sigTrials, 'miss') +
      signalCountBy(sigTrials, 'falseAlarm') +
      signalCountBy(sigTrials, 'falseStart');
    const remaining = Math.max(0, SIGNAL_TRIALS - sigTrialIndex);

    sigLiveStats.innerHTML = '';
    sigLiveStats.append(
      metrics([
        metric('Серия', String(sigStreak)),
        metric('Верно', String(hits)),
        metric('Осталось', String(remaining)),
      ]),
      el('p', { class: 'hint metrics-note' }, [
        `${sigTrialIndex} ${plural(sigTrialIndex, ['сигнал', 'сигнала', 'сигналов'])} · ` +
          `${errors} ${plural(errors, ['ошибка', 'ошибки', 'ошибок'])}`,
      ]),
    );
    sigProgressBar.style.width = `${(sigTrialIndex / SIGNAL_TRIALS) * 100}%`;
  }

  function sigRecordTrial(result: TrialResult): void {
    sigTrials.push(result);
    sigStreak = result.outcome === 'hit' || result.outcome === 'correctIgnore' ? sigStreak + 1 : 0;
    void sigSession?.record({
      signal: result.color,
      isTarget: result.isTarget,
      outcome: result.outcome,
      reactionMs: result.reactionMs,
      // Тот же смысл, что totalMs у «Клика» — единая метрика для
      // сводки в data-summary.ts: «сколько заняла попытка».
      totalMs: result.reactionMs,
      misses: result.outcome === 'hit' || result.outcome === 'correctIgnore' ? 0 : 1,
    });
  }

  function sigScheduleNext(gapMs: number): void {
    sigPhase = 'waiting';
    sigClearTimer();
    sigTimer = window.setTimeout(() => sigShowStimulus(), gapMs);
  }

  function sigShowStimulus(): void {
    if (sigPhase === 'idle' || sigPhase === 'done' || !sigNext) return;
    if (sigTrialIndex >= SIGNAL_TRIALS) {
      void sigFinish();
      return;
    }
    const stim = sigNext;
    sigCurrent = stim;
    // Следующий стимул — сразу же, чтобы его появление никогда не ждало
    // генерации в момент показа текущего.
    sigNext = planNextStimulus(DEFAULT_SIGNAL_TIMINGS, rnd);
    sigResolved = false;
    sigPhase = 'active';
    sigShownAt = performance.now();
    flashSignal(stim.color, DEFAULT_SIGNAL_TIMINGS.showMs);
    sigClearTimer();
    sigTimer = window.setTimeout(() => sigResolveTimeout(), DEFAULT_SIGNAL_TIMINGS.reactionWindowMs);
  }

  function sigResolveTimeout(): void {
    if (sigPhase !== 'active' || sigResolved || !sigCurrent) return;
    sigResolved = true;
    sigRecordTrial(classifyTimeout(sigTrialIndex, sigCurrent.color));
    sigAdvance();
  }

  function sigAdvance(): void {
    sigTrialIndex++;
    sigCurrent = null;
    sigRenderLive();
    if (sigTrialIndex >= SIGNAL_TRIALS || !sigNext) {
      void sigFinish();
      return;
    }
    sigScheduleNext(sigNext.gapMs);
  }

  function onSignalPointerDown(e: PointerEvent): void {
    void e;
    const t = performance.now();
    if (sigPhase === 'waiting') {
      // Клик до появления стимула — фальстарт. Расписание не трогаем:
      // уже подготовленный следующий стимул выходит по плану.
      sigRecordTrial(signalFalseStart(sigTrialIndex));
      sigRenderLive();
      return;
    }
    if (sigPhase !== 'active' || sigResolved || !sigCurrent) return;
    sigResolved = true;
    sigClearTimer();
    sigRecordTrial(classifyReaction(sigTrialIndex, sigCurrent.color, sigShownAt, t));
    sigAdvance();
  }

  function sigRenderSummary(): void {
    sigResultsHost.innerHTML = '';
    const rts = reactionTimes(sigTrials);
    const bestMs = rts.length ? Math.min(...rts) : null;
    const isNewPB = bestMs !== null && (sigPriorBestMs === null || bestMs < sigPriorBestMs);
    const pb = isNewPB ? bestMs : (sigPriorBestMs ?? bestMs);

    sigResultsHost.append(
      statLine([
        ['Медиана реакции', fmtMs(median(rts))],
        ['Лучшая реакция', fmtMs(bestMs)],
        ['P90', fmtMs(p90(rts))],
        ['Точные реакции', String(signalCountBy(sigTrials, 'hit'))],
        ['Ложные тревоги', String(signalCountBy(sigTrials, 'falseAlarm'))],
        ['Фальстарты', String(signalCountBy(sigTrials, 'falseStart'))],
        ['Пропуски', String(signalCountBy(sigTrials, 'miss'))],
        ['Точность', signalAccuracy(sigTrials) === null ? '—' : fmtPct(signalAccuracy(sigTrials))],
        ['Личный рекорд', pb === null ? '—' : `${fmtMs(pb)}${isNewPB ? ' — новый!' : ''}`],
      ]),
    );
  }

  async function sigFinish(): Promise<void> {
    sigPhase = 'done';
    sigClearTimer();
    hideSignal();
    sigPromptEl.textContent = 'Сессия закончена. Результат записан.';
    sigRenderLive();
    sigRenderSummary();

    const rts = reactionTimes(sigTrials);
    await sigSession?.finish({
      trials: sigTrials.length,
      medianReactionMs: median(rts),
      bestReactionMs: rts.length ? Math.min(...rts) : null,
      p90ReactionMs: p90(rts),
      hits: signalCountBy(sigTrials, 'hit'),
      falseAlarms: signalCountBy(sigTrials, 'falseAlarm'),
      falseStarts: signalCountBy(sigTrials, 'falseStart'),
      misses: signalCountBy(sigTrials, 'miss'),
      accuracy: signalAccuracy(sigTrials),
    });
    sigSession = null;
    sigStartBtn.disabled = false;
    sigStopBtn.disabled = true;
    updateExerciseLiveMark();
  }

  const sigStartBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const sigStopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  sigStopBtn.disabled = true;

  sigStartBtn.addEventListener('click', () => {
    if (sigSession) return; // защита от повторного клика, пока идёт запуск
    sigStartBtn.disabled = true;
    void (async () => {
      sigTrials = [];
      sigTrialIndex = 0;
      sigStreak = 0;
      sigResultsHost.innerHTML = '';
      sigPromptEl.textContent = 'Жди сигнал.';
      sigSession = new Session('motorics', 'signal', measuredCalibration(cal, board.size));
      sigStopBtn.disabled = false;
      updateExerciseLiveMark();
      sigPriorBestMs = await historicalBestReactionMs();
      sigNext = planNextStimulus(DEFAULT_SIGNAL_TIMINGS, rnd);
      sigRenderLive();
      sigScheduleNext(sigNext.gapMs);
    })();
  });

  sigStopBtn.addEventListener('click', () => {
    if (sigSession) void sigFinish();
  });

  board.wrap.addEventListener('pointerdown', onSignalPointerDown);

  // --- Переключатель упражнений: тот же board, разные side-панели. ---
  let exercise: Exercise = 'click';
  const clickSideEls = [
    promptEl,
    progress,
    liveStats,
    el('div', { class: 'row' }, [startBtn, stopBtn]),
    el('p', { class: 'hint' }, [
      '30 повторов. Сначала кликни по зелёной клетке, потом по новой зелёной.',
    ]),
    planNextHost,
  ];
  const sigSideEls = [
    sigPromptEl,
    sigProgress,
    sigLiveStats,
    el('div', { class: 'row' }, [sigStartBtn, sigStopBtn]),
    el('p', { class: 'hint' }, [
      `${SIGNAL_TRIALS} сигналов. Клик — только на зелёный, в любом месте доски.`,
    ]),
  ];

  const sideHost = el('div', { class: 'side' });
  const resultsTitleEl = el('h2', {}, ['Разбивка текущей сессии']);
  const resultsBodyHost = el('div', {});

  function renderSide(): void {
    sideHost.innerHTML = '';
    sideHost.append(...(exercise === 'click' ? clickSideEls : sigSideEls));
    // Отдельная разметка side--signal — точечный полиш только для
    // «Сигнала» (мягче карточки метрик, см. board.css), «Клик по
    // клеткам» и остальные модули эти правила не задевают.
    sideHost.classList.toggle('side--signal', exercise === 'signal');
    // Доска чуть заметнее именно в «Сигнале» — она тут главный герой.
    boardHost.classList.toggle('signal-mode', exercise === 'signal');
  }

  function renderResultsHost(): void {
    resultsBodyHost.innerHTML = '';
    resultsTitleEl.textContent = exercise === 'click' ? 'Разбивка текущей сессии' : 'Итог «Сигнала»';
    resultsBodyHost.append(exercise === 'click' ? resultsHost : sigResultsHost);
  }

  const exerciseSeg = segmented<Exercise>(
    [
      { value: 'click', label: 'Вектор' },
      { value: 'signal', label: 'Сигнал' },
    ],
    exercise,
    (v) => {
      if (session || sigSession) {
        // Не даём переключаться на бегу — сначала останови или доиграй.
        exerciseSeg.set(exercise);
        return;
      }
      exercise = v;
      renderSide();
      renderResultsHost();
    },
  );
  exerciseSeg.root.classList.add('exercise-seg');

  /** Маленькая живая точка на активной кнопке, пока идёт сессия. */
  function updateExerciseLiveMark(): void {
    exerciseSeg.root.classList.toggle('is-live', session !== null || sigSession !== null);
  }

  root.append(
    panel('Тренировка', [
      // exerciseSeg — ребёнок .board-area, а не отдельная строка над ней:
      // .board-area:has(.exercise-seg) в styles.css кладёт его в ту же
      // grid-колонку, что и доску, поэтому переключатель всегда ровно той
      // же ширины, что и доска, каким бы ни был откалиброванный размер.
      // Раньше переключатель растягивался на всю ширину панели, и шов
      // между кнопками случайно попадал поверх угла доски.
      el('div', { class: 'board-area' }, [exerciseSeg.root, boardHost, sideHost]),
    ]),
    el('section', { class: 'panel' }, [resultsTitleEl, resultsBodyHost]),
  );

  renderSide();
  renderResultsHost();
  renderLive();
  sigRenderLive();

  return () => {
    board.wrap.removeEventListener('pointermove', onPointerMove);
    board.wrap.removeEventListener('pointerdown', onPointerDown);
    board.wrap.removeEventListener('pointerdown', onSignalPointerDown);
    sigClearTimer();
    if (session) void finish();
    if (sigSession) void sigFinish();
    board.destroy();
  };
}
