import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, metric, metrics, panel, segmented } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { fmtMs, fmtPct, fmtSec, median, p90, plural } from '../core/stats';
import { stepAfter } from './today-plan';
import { checkedColor, dests, fenOf, moveFromUci, posFromFen, type Color } from '../core/chess';
import {
  deltaAnswer,
  generateDeltaTask,
  generateSafeCheckTask,
  matePuzzleQueue,
  puzzleQueue,
  safeCheckQueue,
  taskFromMatePuzzle,
  taskFromPuzzle,
  taskFromSafeCheckPuzzle,
  type DeltaTask,
  type ReactionTask,
} from './reaction-logic';
import { boardRect, keyFromPoint } from './motorics-geometry';
import type { Key } from 'chessground/types';

/**
 * 'delta-from'/'delta-to' — раньше было одно упражнение 'delta' со
 * случайным направлением вопроса на каждое задание. Внутри сессии это
 * значило, что тренируешь то «куда», то «откуда» вперемешку — и не
 * получалось потренировать именно то, что не даётся. Разделили на два
 * упражнения с фиксированным направлением; generateDeltaTask как был,
 * так и остался общим — направление просто передаётся явно.
 */
export type ReactionExercise = 'free-capture' | 'mate-in-1' | 'safe-check' | 'delta-from' | 'delta-to';
export type Exposure = 'unlimited' | '500' | '300' | '200';

const EXERCISE_LABELS: Record<ReactionExercise, string> = {
  'free-capture': 'Что висит?',
  'mate-in-1': 'Мат в 1',
  'safe-check': 'Шах',
  'delta-from': 'Откуда',
  'delta-to': 'Куда',
};

/**
 * Подсказка под доской. Цвет называем прямо, как в premove: позиции здесь
 * случайные, и сторона меняется от задания к заданию. Без этой строчки
 * ученик тыкает в чужие фигуры и решает, что «часть фигур не нажимается»,
 * — хотя доска просто не даёт ходить за соперника.
 *
 * У «изменений позиции» свой текст: там кликают по клетке, а не ходят.
 */
function promptFor(ex: ReactionExercise, userColor: Color): string {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  switch (ex) {
    case 'free-capture':
      return `Играешь ${side}. Забери висящую фигуру. Отбить её нельзя.`;
    case 'mate-in-1':
      return `Играешь ${side}. Поставь мат в один ход.`;
    case 'safe-check':
      return `Играешь ${side}. Найди шах, при котором шахующую фигуру нельзя взять.`;
    case 'delta-from':
    case 'delta-to':
      return '';
  }
}

const EXPOSURE_LABELS: Record<Exposure, string> = {
  unlimited: 'Без лимита',
  '500': '500 мс',
  '300': '300 мс',
  '200': '200 мс',
};

export function exposureMs(e: Exposure): number | null {
  return e === 'unlimited' ? null : Number(e);
}

/**
 * Сколько даётся на решение. Это не то же самое, что экспозиция: та
 * прячет фигуры, но отвечать можно сколько угодно, а здесь по истечении
 * времени задание закрывается как несделанное. Настройки независимы —
 * можно, например, показать позицию на 300 мс и дать 3 секунды на ответ
 * по памяти.
 */
export type TimeLimit = 'unlimited' | '7000' | '5000' | '3000' | '1500' | '500' | '300' | '200';

const TIME_LIMIT_LABELS: Record<TimeLimit, string> = {
  unlimited: 'Без лимита',
  '7000': '7 с',
  '5000': '5 с',
  '3000': '3 с',
  '1500': '1,5 с',
  '500': '0,5 с',
  '300': '0,3 с',
  '200': '0,2 с',
};

/**
 * Порядок кнопок в переключателе — «Без лимита» первым, дальше от долгого
 * лимита к короткому. Не Object.keys(TIME_LIMIT_LABELS): числовые на вид
 * ключи объекта («7000», «200» …) JS сам сортирует по возрастанию перед
 * остальными, независимо от порядка объявления — «Без лимита» уехал бы
 * в конец списка.
 */
const TIME_LIMIT_ORDER: TimeLimit[] = [
  'unlimited',
  '7000',
  '5000',
  '3000',
  '1500',
  '500',
  '300',
  '200',
];

export function timeLimitMs(t: TimeLimit): number | null {
  return t === 'unlimited' ? null : Number(t);
}

// export: сверяется тестом с порогом полноценного завершения в today-plan.ts
export const TASKS_PER_SESSION = 10;

interface Attempt {
  exercise: ReactionExercise;
  exposure: Exposure;
  timeLimit: TimeLimit;
  /** Не успел ответить до истечения лимита — засчитано как несделанное. */
  timedOut?: boolean;
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
  let timeLimit: TimeLimit = 'unlimited';
  const cameFromPlan = consumePlanNavigation();

  root.append(el('h1', {}, ['Тактика']));

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
  const planNextHost = el('div', { class: 'plan-next-host' });

  let session: Session | null = null;
  let taskCount = 0;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  // Очереди задач на текущую сессию, без повторов внутри сессии.
  let puzzles: ReturnType<typeof puzzleQueue> = [];
  let matePuzzles: ReturnType<typeof matePuzzleQueue> = [];
  let safeChecks: ReturnType<typeof safeCheckQueue> = [];
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

  /**
   * Запустить обратный отсчёт на решение. Вызывается ровно там же, где
   * задание становится принимающим ответ, — иначе в «изменениях позиции»
   * лимит съела бы пауза на запоминание исходной позиции.
   */
  function armTimeLimit(): void {
    const ms = timeLimitMs(timeLimit);
    if (ms === null) return;
    later(() => onTimeUp(), ms);
  }

  /** Время вышло: закрываем задание как несделанное и показываем ответ. */
  function onTimeUp(): void {
    if (!accepting) return;
    accepting = false;
    const t = performance.now();
    board.setPiecesHidden(false);

    if (delta) {
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
        timeLimit,
        timedOut: true,
        correct: false,
        latencyMs: t - shownAt,
        answer: '—',
        expected: deltaAnswer(delta),
        fen: delta.fen,
      });
      return;
    }

    if (!current) return;
    board.setPosition({
      fen: current.fen,
      orientation: current.userColor,
      turnColor: current.pos.turn,
      movableColor: undefined,
      viewOnly: true,
      check: checkedColor(current.pos),
    });
    record({
      exercise,
      exposure,
      timeLimit,
      timedOut: true,
      correct: false,
      latencyMs: t - shownAt,
      answer: '—',
      expected: current.solutions.map((s) => s.uci).join(' '),
      fen: current.fen,
      puzzleId: currentPuzzleId,
    });
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

    if (exercise === 'delta-from' || exercise === 'delta-to') {
      const t = generateDeltaTask(rnd, 400, exercise === 'delta-to' ? 'to' : 'from');
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
        promptEl.textContent =
          t.direction === 'to'
            ? 'Куда переместилась фигура? Кликни по полю прихода.'
            : 'Откуда переместилась фигура? Кликни по полю ухода.';
        shownAt = performance.now();
        accepting = true;
        applyExposure();
        armTimeLimit();
      }, 900);
      return;
    }

    let t: ReactionTask | null;
    if (exercise === 'free-capture') {
      // Реальные задачи Lichess вместо случайной расстановки.
      const puzzle = puzzles.shift();
      t = puzzle ? taskFromPuzzle(puzzle) : null;
      currentPuzzleId = puzzle?.id ?? '';
    } else if (exercise === 'mate-in-1') {
      const puzzle = matePuzzles.shift();
      t = puzzle ? taskFromMatePuzzle(puzzle) : null;
      currentPuzzleId = puzzle?.id ?? '';
    } else {
      // Позиции из настоящих партий, как в двух упражнениях выше.
      // Случайная расстановка остаётся запасным вариантом: она никогда не
      // кончается, а набор конечен — но при 200 задачах на сессию из 10
      // до неё доходит только если набор чем-то испорчен.
      const puzzle = safeChecks.shift();
      t = puzzle ? taskFromSafeCheckPuzzle(puzzle) : generateSafeCheckTask(rnd);
      currentPuzzleId = puzzle?.id ?? '';
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
    promptEl.textContent = promptFor(exercise, t.userColor);
    shownAt = performance.now();
    accepting = true;
    applyExposure();
    armTimeLimit();
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
      timeLimit,
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
    const correct = key === deltaAnswer(delta);
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
      timeLimit,
      correct,
      latencyMs: t - shownAt,
      answer: key,
      expected: deltaAnswer(delta),
      fen: delta.fen,
    });
  }

  function record(a: Attempt): void {
    attempts.push(a);
    taskCount++;
    void session?.record({ ...a });
    verdictEl.textContent = a.correct
      ? `Верно, ${fmtMs(a.latencyMs)}.`
      : a.timedOut
        ? `Время вышло. Правильно: ${a.expected}.`
        : `Мимо. Правильно: ${a.expected}.`;
    verdictEl.className = a.correct ? 'prompt verdict-ok' : 'prompt verdict-bad';
    renderLive();
    later(nextTask, 1200);
  }

  /** Тот же расчёт, что в motorics.ts: без старта — пусто, после финиша — заморожено. */
  function elapsedMs(): number | null {
    if (startedAt === null) return null;
    return (finishedAt ?? performance.now()) - startedAt;
  }

  /** Единый вид результатов — как в motorics.ts, premove.ts и openings.ts. */
  function renderLive(): void {
    const n = attempts.length;
    const correct = attempts.filter((a) => a.correct);
    const missCount = n - correct.length;
    liveStats.innerHTML = '';
    liveStats.append(
      metrics([
        metric('Скорость', fmtSec(median(correct.map((a) => a.latencyMs)))),
        metric('Без ошибок', fmtPct(n ? correct.length / n : null)),
        metric('Общее время', fmtSec(elapsedMs(), 1)),
      ]),
      el('p', { class: 'hint metrics-note' }, [
        `${n} ${plural(n, ['задание', 'задания', 'заданий'])} · ` +
          `${missCount} ${plural(missCount, ['промах', 'промаха', 'промахов'])}`,
      ]),
    );
  }

  async function finish(): Promise<void> {
    clearTimers();
    accepting = false;
    finishedAt = performance.now();
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
    renderLive();
    renderPlanNext();
  }

  /** Часть дневной тренировки «Сегодня» — см. пояснение в motorics.ts. */
  function renderPlanNext(): void {
    planNextHost.innerHTML = '';
    if (!cameFromPlan) return;
    const next = stepAfter('reaction', new Date());
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

  const timeLimitSeg = segmented<TimeLimit>(
    TIME_LIMIT_ORDER.map((k) => ({
      value: k,
      label: TIME_LIMIT_LABELS[k],
    })),
    timeLimit,
    (v) => {
      timeLimit = v;
    },
  );

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const stopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  stopBtn.disabled = true;

  startBtn.addEventListener('click', () => {
    attempts.length = 0;
    taskCount = 0;
    startedAt = performance.now();
    finishedAt = null;
    planNextHost.innerHTML = '';
    puzzles = exercise === 'free-capture' ? puzzleQueue(rnd, TASKS_PER_SESSION) : [];
    matePuzzles = exercise === 'mate-in-1' ? matePuzzleQueue(rnd, TASKS_PER_SESSION) : [];
    safeChecks = exercise === 'safe-check' ? safeCheckQueue(rnd, TASKS_PER_SESSION) : [];
    // Лимит времени дописываем в режим, иначе в «Прогрессе» сессия на
    // 0,2 с легла бы в одну строку с сессией без лимита — а это разные
    // условия. Без лимита строка режима прежняя: так вся уже накопленная
    // история продолжает совпадать с новыми записями.
    const modeKey = timeLimit === 'unlimited' ? `${exercise}:${exposure}` : `${exercise}:${exposure}:lim${timeLimit}`;
    session = new Session('reaction', modeKey, measuredCalibration(cal, board.size));
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
      el('div', { class: 'row' }, [el('label', {}, ['Показ фигур']), exposureSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Лимит времени']), timeLimitSeg.root]),
      el('p', { class: 'hint' }, [
        'Показ фигур — сколько времени видно позицию: после этого фигуры ',
        'скрываются, и решение идёт по памяти. Лимит времени — сколько ',
        'всего даётся на ответ: не успел, задание засчитывается как ',
        'несделанное. Настройки независимы.',
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
          planNextHost,
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
