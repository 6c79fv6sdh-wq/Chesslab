import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, panel, statLine, table } from '../core/ui';
import { Session } from '../core/session';
import { fmtMs, fmtNum, fmtPct, groupBy, median, p90 } from '../core/stats';
import { directionBetween, squareDistance, type Direction } from '../core/chess';
import {
  EMPTY_BOARD_FEN,
  boardRect,
  keyFromPoint,
  squareCenter,
  type PointerSample,
} from './motorics-geometry';

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

export function mountMotorics(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;

  root.append(el('h1', {}, ['Моторика']));

  const boardHost = el('div', { class: 'board-host' });
  const trace = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  trace.setAttribute('class', 'hl-trace');
  trace.setAttribute('viewBox', `0 0 ${cal.boardSize} ${cal.boardSize}`);

  const board = new Board(boardHost, {
    orientation: 'white',
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
    viewOnly: true,
  });
  board.setPosition({
    fen: EMPTY_BOARD_FEN,
    orientation: 'white',
    turnColor: 'white',
    viewOnly: true,
  });
  boardHost.append(trace);

  const promptEl = el('div', { class: 'prompt' }, ['Нажми «Старт».']);
  const progressBar = el('div', {});
  const progress = el('div', { class: 'progress' }, [progressBar]);
  const liveStats = el('div', {});
  const resultsHost = el('div', {});

  let phase: Phase = 'idle';
  let session: Session | null = null;
  let repIndex = 0;
  let source = '';
  let target = '';
  let stimulusAt = 0;
  let sourceHitAt = 0;
  let firstMoveAt: number | null = null;
  let misses = 0;
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
    poly.setAttribute('stroke', '#3692e7');
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

  function renderLive(): void {
    const done = results.length;
    const totals = results.map((r) => r.totalMs);
    const hitRate = done ? results.filter((r) => r.misses === 0).length / done : null;
    liveStats.innerHTML = '';
    liveStats.append(
      statLine([
        ['Повторов', `${done} / ${REPS}`],
        ['Медиана полного', fmtMs(median(totals))],
        ['P90 полного', fmtMs(p90(totals))],
        ['Без промахов', fmtPct(hitRate)],
      ]),
    );
    progressBar.style.width = `${(done / REPS) * 100}%`;
  }

  async function finish(): Promise<void> {
    phase = 'done';
    highlight([]);
    promptEl.textContent = 'Сессия закончена. Результат записан.';
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
    renderBreakdown();
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
    session = new Session('motorics', 'source-target', cal);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    renderLive();
    nextRep();
  });

  stopBtn.addEventListener('click', () => {
    if (session) void finish();
  });

  board.wrap.addEventListener('pointermove', onPointerMove);
  board.wrap.addEventListener('pointerdown', onPointerDown);

  root.append(
    panel('Тренировка', [
      el('div', { class: 'board-area' }, [
        boardHost,
        el('div', { class: 'side' }, [
          promptEl,
          progress,
          liveStats,
          el('div', { class: 'row' }, [startBtn, stopBtn]),
          el('p', { class: 'hint' }, [
            '30 повторов. Сначала кликни по зелёной клетке, потом по новой зелёной.',
          ]),
        ]),
      ]),
    ]),
    panel('Разбивка текущей сессии', [resultsHost]),
  );

  renderLive();

  return () => {
    board.wrap.removeEventListener('pointermove', onPointerMove);
    board.wrap.removeEventListener('pointerdown', onPointerDown);
    if (session) void finish();
    board.destroy();
  };
}
