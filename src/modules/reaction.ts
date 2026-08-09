import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, panel, segmented, statLine } from '../core/ui';
import { Session } from '../core/session';
import { fmtMs, fmtPct, median, p90 } from '../core/stats';
import { checkedColor, dests, fenOf, moveFromUci, posFromFen } from '../core/chess';
import {
  generateDeltaTask,
  generateSafeCheckTask,
  puzzleCount,
  puzzleQueue,
  taskFromPuzzle,
  type DeltaTask,
  type ReactionTask,
} from './reaction-logic';
import { boardRect, keyFromPoint } from './motorics-geometry';
import type { Key } from 'chessground/types';

export type ReactionExercise = 'free-capture' | 'safe-check' | 'delta';
export type Exposure = 'unlimited' | '500' | '300' | '200';

const EXERCISE_LABELS: Record<ReactionExercise, string> = {
  'free-capture': 'Бесплатное взятие',
  'safe-check': 'Безопасный шах',
  delta: 'Дельта позиции',
};

const EXPOSURE_LABELS: Record<Exposure, string> = {
  unlimited: 'Без лимита',
  '500': '500 мс',
  '300': '300 мс',
  '200': '200 мс',
};

export function exposureMs(e: Exposure): number | null {
  return e === 'unlimited' ? null : Number(e);
}

const TASKS_PER_SESSION = 10;

interface Attempt {
  exercise: ReactionExercise;
  exposure: Exposure;
  correct: boolean;
  latencyMs: number;
  answer: string;
  expected: string;
  fen: string;
  /** Идентификатор задачи Lichess, если упражнение идёт по набору. */
  puzzleId?: string;
}

export function mountReaction(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  let exercise: ReactionExercise = 'free-capture';
  let exposure: Exposure = 'unlimited';

  root.append(el('h1', {}, ['Реакция']));

  const boardHost = el('div', { class: 'board-host' });
  const board = new Board(boardHost, {
    orientation: 'white',
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
  });

  const promptEl = el('div', { class: 'prompt' }, ['Выбери упражнение и нажми «Старт».']);
  const verdictEl = el('div', { class: 'prompt' }, ['']);
  const liveStats = el('div', {});

  let session: Session | null = null;
  let taskCount = 0;
  // Очередь задач «висящая фигура» на текущую сессию, без повторов.
  let puzzles: ReturnType<typeof puzzleQueue> = [];
  let currentPuzzleId = '';
  let current: ReactionTask | null = null;
  let delta: DeltaTask | null = null;
  let shownAt = 0;
  let accepting = false;
  const attempts: Attempt[] = [];
  const timers: number[] = [];

  const rnd = () => Math.random();

  function later(fn: () => void, ms: number): void {
    timers.push(window.setTimeout(fn, ms));
  }

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
  }

  function applyExposure(): void {
    const ms = exposureMs(exposure);
    board.setPiecesHidden(false);
    if (ms === null) return;
    later(() => board.setPiecesHidden(true), ms);
  }

  function nextTask(): void {
    clearTimers();
    if (!session) return;
    if (taskCount >= TASKS_PER_SESSION) {
      void finish();
      return;
    }
    verdictEl.textContent = '';
    verdictEl.className = 'prompt';
    current = null;
    delta = null;

    if (exercise === 'delta') {
      const t = generateDeltaTask(rnd);
      if (!t) {
        promptEl.textContent = 'Не удалось собрать позицию, пробую ещё раз.';
        later(nextTask, 50);
        return;
      }
      delta = t;
      // Сначала показываем позицию ДО хода соперника.
      board.setPosition({
        fen: t.fen,
        orientation: t.userColor,
        turnColor: t.pos.turn,
        movableColor: undefined,
        viewOnly: true,
      });
      promptEl.textContent = 'Запомни позицию. Соперник сейчас сходит.';
      board.setPiecesHidden(false);
      accepting = false;
      later(() => {
        if (!delta) return;
        const after = posFromFen(t.afterFen);
        board.setPosition({
          fen: t.afterFen,
          orientation: t.userColor,
          turnColor: after.turn,
          movableColor: undefined,
          viewOnly: true,
          check: checkedColor(after),
        });
        promptEl.textContent = 'Куда пришёл ход? Кликни по полю прихода.';
        shownAt = performance.now();
        accepting = true;
        applyExposure();
      }, 900);
      return;
    }

    let t: ReactionTask | null;
    if (exercise === 'free-capture') {
      // Реальные задачи Lichess вместо случайной расстановки.
      const puzzle = puzzles.shift();
      t = puzzle ? taskFromPuzzle(puzzle) : null;
      currentPuzzleId = puzzle?.id ?? '';
    } else {
      t = generateSafeCheckTask(rnd);
      currentPuzzleId = '';
    }
    if (!t) {
      promptEl.textContent = 'Задачи в наборе кончились.';
      void finish();
      return;
    }
    current = t;
    board.setPosition({
      fen: t.fen,
      orientation: t.userColor,
      turnColor: t.pos.turn,
      movableColor: t.userColor,
      dests: dests(t.pos),
      check: checkedColor(t.pos),
    });
    promptEl.textContent =
      exercise === 'free-capture'
        ? 'Забери висящую фигуру. Отбить её нельзя.'
        : 'Найди шах, при котором шахующую фигуру нельзя взять.';
    shownAt = performance.now();
    accepting = true;
    applyExposure();
  }

  function onMove(orig: Key, dest: Key): void {
    if (!accepting || !current) return;
    accepting = false;
    const uci = `${orig}${dest}`;
    const correct = current.solutions.some((s) => s.uci === uci);
    const t = performance.now();

    // Доска всегда слепок FEN: показываем позицию после хода либо исходную.
    if (correct) {
      const after = current.pos.clone();
      const mv = moveFromUci(uci);
      if (after.isLegal(mv)) after.play(mv);
      board.setPiecesHidden(false);
      board.setPosition({
        fen: fenOf(after),
        orientation: current.userColor,
        turnColor: after.turn,
        movableColor: undefined,
        lastMove: [orig, dest],
        check: checkedColor(after),
        viewOnly: true,
      });
    } else {
      board.setPiecesHidden(false);
      board.setPosition({
        fen: current.fen,
        orientation: current.userColor,
        turnColor: current.pos.turn,
        movableColor: undefined,
        viewOnly: true,
        check: checkedColor(current.pos),
      });
    }

    record({
      exercise,
      exposure,
      correct,
      latencyMs: t - shownAt,
      answer: uci,
      expected: current.solutions.map((s) => s.uci).join(' '),
      fen: current.fen,
      puzzleId: currentPuzzleId,
    });
  }

  function onPointerDown(e: PointerEvent): void {
    if (!accepting || !delta) return;
    const rect = boardRect(board.wrap);
    const key = keyFromPoint(e.clientX, e.clientY, rect, delta.userColor);
    if (!key) return;
    accepting = false;
    const t = performance.now();
    const correct = key === delta.to;
    board.setPiecesHidden(false);
    const after = posFromFen(delta.afterFen);
    board.setPosition({
      fen: delta.afterFen,
      orientation: delta.userColor,
      turnColor: after.turn,
      movableColor: undefined,
      viewOnly: true,
      lastMove: [delta.from as Key, delta.to as Key],
      check: checkedColor(after),
    });
    record({
      exercise,
      exposure,
      correct,
      latencyMs: t - shownAt,
      answer: key,
      expected: delta.to,
      fen: delta.fen,
    });
  }

  function record(a: Attempt): void {
    attempts.push(a);
    taskCount++;
    void session?.record({ ...a });
    verdictEl.textContent = a.correct
      ? `Верно, ${fmtMs(a.latencyMs)}.`
      : `Мимо. Правильно: ${a.expected}.`;
    verdictEl.className = a.correct ? 'prompt verdict-ok' : 'prompt verdict-bad';
    renderLive();
    later(nextTask, 1200);
  }

  function renderLive(): void {
    const n = attempts.length;
    const correct = attempts.filter((a) => a.correct);
    liveStats.innerHTML = '';
    liveStats.append(
      statLine([
        ['Заданий', `${n} / ${TASKS_PER_SESSION}`],
        ['Точность', n ? fmtPct(correct.length / n) : '—'],
        ['Медиана верных', fmtMs(median(correct.map((a) => a.latencyMs)))],
        ['P90 верных', fmtMs(p90(correct.map((a) => a.latencyMs)))],
      ]),
    );
  }

  async function finish(): Promise<void> {
    clearTimers();
    accepting = false;
    board.setPiecesHidden(false);
    const correct = attempts.filter((a) => a.correct);
    await session?.finish({
      attempts: attempts.length,
      accuracy: attempts.length ? correct.length / attempts.length : null,
      medianMs: median(correct.map((a) => a.latencyMs)),
      p90Ms: p90(correct.map((a) => a.latencyMs)),
      exposure,
    });
    session = null;
    promptEl.textContent = 'Сессия закончена. Результат записан.';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  const exerciseSeg = segmented<ReactionExercise>(
    (Object.keys(EXERCISE_LABELS) as ReactionExercise[]).map((k) => ({
      value: k,
      label: EXERCISE_LABELS[k],
    })),
    exercise,
    (v) => {
      exercise = v;
      if (!session) promptEl.textContent = `${EXERCISE_LABELS[v]}. Нажми «Старт».`;
    },
  );

  const exposureSeg = segmented<Exposure>(
    (Object.keys(EXPOSURE_LABELS) as Exposure[]).map((k) => ({ value: k, label: EXPOSURE_LABELS[k] })),
    exposure,
    (v) => {
      exposure = v;
    },
  );

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const stopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  stopBtn.disabled = true;

  startBtn.addEventListener('click', () => {
    attempts.length = 0;
    taskCount = 0;
    puzzles = exercise === 'free-capture' ? puzzleQueue(rnd, TASKS_PER_SESSION) : [];
    session = new Session('reaction', `${exercise}:${exposure}`, cal);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    renderLive();
    nextTask();
  });

  stopBtn.addEventListener('click', () => {
    if (session) void finish();
  });

  board.setOptions({ onMove });
  board.wrap.addEventListener('pointerdown', onPointerDown);

  root.append(
    panel('Упражнение', [
      exerciseSeg.root,
      el('div', { class: 'row' }, [el('label', {}, ['Экспозиция']), exposureSeg.root]),
      el('p', { class: 'hint' }, [
        'После лимита экспозиции фигуры скрываются, решение идёт по памяти.',
      ]),
      el('p', { class: 'hint' }, [
        `«Бесплатное взятие» идёт по ${puzzleCount()} реальным задачам Lichess. `,
        'Остальные два упражнения пока на случайных позициях.',
      ]),
    ]),
    panel('Тренировка', [
      el('div', { class: 'board-area' }, [
        boardHost,
        el('div', { class: 'side' }, [
          promptEl,
          verdictEl,
          liveStats,
          el('div', { class: 'row' }, [startBtn, stopBtn]),
        ]),
      ]),
    ]),
  );

  renderLive();

  return () => {
    clearTimers();
    board.wrap.removeEventListener('pointerdown', onPointerDown);
    if (session) void finish();
    board.destroy();
  };
}
