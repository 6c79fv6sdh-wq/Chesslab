import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, metric, metrics, panel, segmented, table } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { allSessions } from '../core/db';
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
import {
  KNIGHT_SCAN_KNIGHT_ICON,
  KNIGHT_SCAN_OBSTACLE_ICON,
  KNIGHT_SCAN_SCORED,
  KNIGHT_SCAN_WARMUP,
  generateKnightScanSession,
  knightScanMeasurementData,
  type KnightBoard,
  type KnightScanLevel,
  type KnightScanRound,
  type KnightScanSession,
} from './knight-scan-logic';
import { SNAPSHOT_PIECE_ICON } from '../data/snapshot-icons';
import {
  ALL_SQUARES,
  SNAPSHOT_SCORED,
  SNAPSHOT_WARMUP,
  generateSnapshotSession,
  piecesToFen,
  scoreAttempt,
  summarizeAttempt,
  type AttemptSummary,
  type PieceResult,
  type Placement,
  type PlacedPiece,
  type SnapshotDifficulty,
  type SnapshotSession,
  type SnapshotTask,
} from './snapshot-logic';
import type { Role } from '../core/chess';

/**
 * 'delta-from'/'delta-to' — раньше было одно упражнение 'delta' со
 * случайным направлением вопроса на каждое задание. Внутри сессии это
 * значило, что тренируешь то «куда», то «откуда» вперемешку — и не
 * получалось потренировать именно то, что не даётся. Разделили на два
 * упражнения с фиксированным направлением; generateDeltaTask как был,
 * так и остался общим — направление просто передаётся явно.
 */
export type ReactionExercise =
  | 'free-capture'
  | 'mate-in-1'
  | 'safe-check'
  | 'delta-from'
  | 'delta-to'
  | 'knight-scan'
  | 'snapshot';
export type Exposure = 'unlimited' | '500' | '300' | '200';

const EXERCISE_LABELS: Record<ReactionExercise, string> = {
  'free-capture': 'Что висит?',
  'mate-in-1': 'Мат в 1',
  'safe-check': 'Шах',
  'delta-from': 'Откуда',
  'delta-to': 'Куда',
  'knight-scan': 'Скан конём',
  snapshot: 'Snapshot',
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
    case 'knight-scan':
    case 'snapshot':
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

  // --- «Скан конём»: механика (четыре мини-доски, BFS, выбор клавишей
  // 1-4) совсем другая, чем у остальных упражнений «Тактики» — своё
  // состояние, свои функции, общий только модуль и запись в Session.
  interface KsAttempt {
    round: KnightScanRound;
    chosenIndex: number;
    correct: boolean;
    latencyMs: number;
  }
  let ksSession: KnightScanSession | null = null;
  let ksRoundPos = 0;
  let ksScored = 0;
  let ksAttempts: KsAttempt[] = [];
  let ksArmed = false;
  let ksShownAt = 0;
  let ksBoardSize = 0;
  let ksGridWidthAtShow = 0;
  let ksFeedbackTimer: number | null = null;
  let ksPhase: 'idle' | 'active' | 'done' = 'idle';

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

  // --- «Скан конём»: четыре мини-доски строятся ОДИН раз при монтировании
  // и дальше только перекрашиваются (paintKsBoard) — по заданию размеры и
  // положение досок не должны меняться в течение попытки, а пересоздавать
  // DOM между заданиями значило бы рисковать этим на каждый кадр.
  interface KsBoardHandle {
    root: HTMLElement;
    squares: HTMLElement[];
  }
  const ksBoards: KsBoardHandle[] = [];
  for (let i = 0; i < 4; i++) {
    const boardRoot = el('div', { class: 'ks-board', role: 'button', tabindex: '0', 'aria-label': `Доска ${i + 1}` });
    boardRoot.append(el('span', { class: 'ks-index' }, [String(i + 1)]));
    const squares: HTMLElement[] = [];
    for (let sq = 0; sq < 64; sq++) {
      const file = sq % 8;
      const rank = Math.floor(sq / 8);
      const dark = (file + rank) % 2 === 0;
      const cell = el('div', { class: `ks-sq ${dark ? 'ks-sq-dark' : 'ks-sq-light'}` });
      boardRoot.append(cell);
      squares.push(cell);
    }
    ksBoards.push({ root: boardRoot, squares });
  }

  function ksPieceEl(src: string, cls: string): HTMLElement {
    const s = el('span', { class: `ks-piece ${cls}`, 'aria-hidden': 'true' });
    s.style.backgroundImage = `url("${src}")`;
    return s;
  }

  function paintKsBoard(handle: KsBoardHandle, b: KnightBoard): void {
    for (const sq of handle.squares) {
      sq.innerHTML = '';
      sq.classList.remove('ks-target');
    }
    handle.squares[b.knight].append(ksPieceEl(KNIGHT_SCAN_KNIGHT_ICON, 'ks-knight'));
    for (const obs of b.obstacles) {
      handle.squares[obs].append(ksPieceEl(KNIGHT_SCAN_OBSTACLE_ICON, 'ks-obstacle'));
    }
    const targetEl = handle.squares[b.target];
    targetEl.classList.add('ks-target');
    targetEl.append(el('span', { class: 'ks-target-ring', 'aria-hidden': 'true' }));
  }

  /** Кратчайший путь верной доски, маленькими пронумерованными точками — только как ответ после ошибки. */
  function showKsPath(handle: KsBoardHandle, path: number[]): void {
    path.forEach((sq, i) => {
      if (i === 0) return; // старт уже занят конём — вторая метка там не нужна
      handle.squares[sq].append(el('span', { class: 'ks-path-dot' }, [String(i)]));
    });
  }

  function clearKsFlash(): void {
    for (const b of ksBoards) b.root.classList.remove('ks-flash-ok', 'ks-flash-bad');
  }

  const ksTitleEl = el('div', { class: 'ks-title' }, ['Скан конём']);
  const ksIdleHint = el('p', { class: 'hint' }, [
    'Четыре мини-доски. На одной кратчайший путь коня до зелёной клетки — ',
    'ровно нужное число ходов, на остальных длиннее или пути нет вовсе. ',
    'Выбирай доску кликом или клавишами 1–4.',
  ]);
  const ksPromptEl = el('div', { class: 'prompt' }, ['']);
  const ksCounterEl = el('div', { class: 'ks-counter hint' }, ['']);
  const ksGrid = el('div', { class: 'ks-grid' }, ksBoards.map((b) => b.root));
  const ksStartBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const ksStopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  ksStopBtn.disabled = true;
  const ksResultsHost = el('div', {});

  /**
   * Что видно на экране, зависит от фазы: во время самой сессии — по
   * заданию только название, формулировка, счётчик, доски и «Прервать»;
   * до и после — ещё подсказка/кнопка «Старт»/результаты.
   */
  function renderKsVisibility(): void {
    const active = ksPhase === 'active';
    ksIdleHint.style.display = ksPhase === 'idle' ? '' : 'none';
    ksPromptEl.style.display = active ? '' : 'none';
    ksCounterEl.style.display = active ? '' : 'none';
    ksGrid.style.display = active ? '' : 'none';
    ksResultsHost.style.display = ksPhase === 'done' ? '' : 'none';
    ksStartBtn.style.display = active ? 'none' : '';
    ksStartBtn.disabled = active;
    ksStopBtn.disabled = !active;
  }

  function updateKsCounter(): void {
    if (!ksSession) return;
    const warmup = ksRoundPos < KNIGHT_SCAN_WARMUP;
    ksCounterEl.textContent = warmup
      ? `Разминка ${ksRoundPos + 1} / ${KNIGHT_SCAN_WARMUP}`
      : `Задание ${ksScored + 1} / ${KNIGHT_SCAN_SCORED}`;
  }

  /** Показать текущий раунд заново, сбросив таймер, — используется и для первого показа, и для перезапуска после сбоя замера. */
  function showKsRound(): void {
    if (!ksSession) return;
    ksArmed = false;
    clearKsFlash();
    if (ksFeedbackTimer !== null) {
      window.clearTimeout(ksFeedbackTimer);
      ksFeedbackTimer = null;
    }
    const round = ksSession.rounds[ksRoundPos];
    ksBoards.forEach((handle, i) => paintKsBoard(handle, round.boards[i]));
    const warmup = ksRoundPos < KNIGHT_SCAN_WARMUP;
    ksPromptEl.textContent =
      `${warmup ? 'Разминка. ' : ''}Найди доску, где кратчайший путь коня до зелёной клетки ` +
      `занимает ровно ${round.level} ${plural(round.level, ['ход', 'хода', 'ходов'])}.`;
    updateKsCounter();
    // Таймер — только после полной отрисовки всех четырёх досок, кадром
    // requestAnimationFrame, а не сразу: иначе в замер попало бы и время
    // на сам рендер разметки, которое от решающего никак не зависит.
    requestAnimationFrame(() => {
      if (!ksSession || ksPhase !== 'active') return; // сессию успели прервать, пока ждали кадр
      ksBoardSize = ksBoards[0].root.getBoundingClientRect().width;
      ksGridWidthAtShow = ksGrid.getBoundingClientRect().width;
      ksShownAt = performance.now();
      ksArmed = true;
    });
  }

  /**
   * Вкладка потеряла фокус или доски перерисовались другого размера —
   * оба по заданию делают текущий замер не в счёт. Проще всего просто
   * показать то же самое задание заново: разминочный счётчик/индекс
   * раунда не сдвигается, значит зачётных замеров в сессии всё равно
   * наберётся ровно KNIGHT_SCAN_SCORED.
   */
  function ksInvalidate(): void {
    if (!ksSession || !ksArmed) return;
    showKsRound();
  }

  function onKsVisibilityChange(): void {
    if (document.hidden) ksInvalidate();
  }

  const ksResizeObserver = new ResizeObserver(() => {
    if (!ksSession || !ksArmed) return;
    const w = ksGrid.getBoundingClientRect().width;
    if (Math.abs(w - ksGridWidthAtShow) > 0.5) ksInvalidate();
  });
  ksResizeObserver.observe(ksGrid);
  document.addEventListener('visibilitychange', onKsVisibilityChange);

  function onKsChoose(index: number, pointerType: string, atMs: number): void {
    if (!ksSession || !ksArmed) return;
    ksArmed = false;
    const round = ksSession.rounds[ksRoundPos];
    const correct = index === round.correctIndex;
    const latencyMs = atMs - ksShownAt;
    const warmup = ksRoundPos < KNIGHT_SCAN_WARMUP;

    clearKsFlash();
    ksBoards[index].root.classList.add(correct ? 'ks-flash-ok' : 'ks-flash-bad');
    if (!correct) {
      ksBoards[round.correctIndex].root.classList.add('ks-flash-ok');
      const correctBoard = round.boards[round.correctIndex];
      if (correctBoard.path) showKsPath(ksBoards[round.correctIndex], correctBoard.path);
    }

    if (!warmup) {
      const kind = pointerType === 'mouse' || pointerType === 'touch' ? pointerType : 'keyboard';
      const data = knightScanMeasurementData({
        round,
        chosenIndex: index,
        latencyMs,
        pointerType: kind,
        boardSize: ksBoardSize,
        seed: ksSession.seed,
      });
      ksAttempts.push({ round, chosenIndex: index, correct, latencyMs });
      void session?.record(data);
      ksScored++;
    }

    // Верно — «кратко подсвечивается», сразу следующее; неверно — 800 мс
    // на показ правильного пути, как в задании.
    ksFeedbackTimer = window.setTimeout(
      () => {
        ksFeedbackTimer = null;
        ksRoundPos++;
        if (!ksSession || ksRoundPos >= ksSession.rounds.length) {
          void finishKnightScan();
          return;
        }
        showKsRound();
      },
      correct ? 260 : 800,
    );
  }

  function onKsKeydown(e: KeyboardEvent): void {
    if (ksPhase !== 'active') return;
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx === -1) return;
    onKsChoose(idx, 'keyboard', performance.now());
  }
  document.addEventListener('keydown', onKsKeydown);

  ksBoards.forEach((handle, i) => {
    handle.root.addEventListener('pointerdown', (e) => onKsChoose(i, e.pointerType || 'mouse', performance.now()));
  });

  function startKnightScan(): void {
    ksSession = generateKnightScanSession(rnd);
    ksRoundPos = 0;
    ksScored = 0;
    ksAttempts = [];
    ksPhase = 'active';
    planNextHost.innerHTML = '';
    // Главная доска (board.size) в «Скане» не участвует — размер мини-досок
    // фиксируется отдельно в каждом замере (см. knightScanMeasurementData).
    session = new Session('reaction', 'knight-scan', cal);
    renderKsVisibility();
    showKsRound();
  }

  async function finishKnightScan(): Promise<void> {
    if (ksFeedbackTimer !== null) {
      window.clearTimeout(ksFeedbackTimer);
      ksFeedbackTimer = null;
    }
    ksArmed = false;
    ksPhase = 'done';

    const byLevel = (lvl: KnightScanLevel) => ksAttempts.filter((a) => a.round.level === lvl);
    const accOf = (arr: KsAttempt[]): number | null => (arr.length ? arr.filter((a) => a.correct).length / arr.length : null);
    const medOf = (arr: KsAttempt[]): number | null => median(arr.filter((a) => a.correct).map((a) => a.latencyMs));
    const correctAttempts = ksAttempts.filter((a) => a.correct);

    const summary: Record<string, number | string | null> = {
      attempts: ksAttempts.length,
      accuracy: accOf(ksAttempts),
      medianMs: medOf(ksAttempts),
      p90Ms: p90(correctAttempts.map((a) => a.latencyMs)),
      errors: ksAttempts.length - correctAttempts.length,
      accuracyN2: accOf(byLevel(2)),
      medianN2: medOf(byLevel(2)),
      accuracyN3: accOf(byLevel(3)),
      medianN3: medOf(byLevel(3)),
      accuracyN4: accOf(byLevel(4)),
      medianN4: medOf(byLevel(4)),
      seed: ksSession?.seed ?? null,
    };

    const finishedId = session?.id ?? null;
    await session?.finish(summary);
    session = null;
    ksSession = null;
    await renderKsResults(summary, finishedId);
    renderKsVisibility();
  }

  /** Сводка по сессии + сравнение с предыдущей сессией «Скана конём» на этом же устройстве (по активному профилю). */
  async function renderKsResults(summary: Record<string, number | string | null>, finishedId: string | null): Promise<void> {
    ksResultsHost.innerHTML = '';
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const all = await allSessions();
    const prev =
      all
        .filter((s) => s.module === 'reaction' && s.mode === 'knight-scan' && s.id !== finishedId)
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    const prevAcc = prev ? num(prev.summary.accuracy) : null;
    const prevMed = prev ? num(prev.summary.medianMs) : null;

    const compare = (cur: number | null, prevV: number | null, fmt: (v: number | null) => string): string => {
      if (!prev) return 'первая сессия «Скана конём»';
      if (cur === null || prevV === null) return '';
      const diffIsBetterAccuracy = fmt === fmtPct ? cur >= prevV : cur <= prevV;
      return `было ${fmt(prevV)} · ${diffIsBetterAccuracy ? 'лучше' : 'хуже'} прошлой сессии`;
    };

    const errors = num(summary.errors) ?? 0;
    ksResultsHost.append(
      metrics([
        metric('Точность', fmtPct(num(summary.accuracy)), compare(num(summary.accuracy), prevAcc, fmtPct)),
        metric('Медиана', fmtMs(num(summary.medianMs)), compare(num(summary.medianMs), prevMed, fmtMs)),
        metric('P90', fmtMs(num(summary.p90Ms))),
      ]),
      el('p', { class: 'hint metrics-note' }, [
        `${errors} ${plural(errors, ['ошибка', 'ошибки', 'ошибок'])} из ${KNIGHT_SCAN_SCORED}`,
      ]),
      table(
        ['Сложность', 'Точность', 'Медиана'],
        ([2, 3, 4] as KnightScanLevel[]).map((lvl) => [
          `N = ${lvl}`,
          fmtPct(num(summary[`accuracyN${lvl}`])),
          fmtMs(num(summary[`medianN${lvl}`])),
        ]),
      ),
    );
  }

  ksStartBtn.addEventListener('click', () => startKnightScan());
  ksStopBtn.addEventListener('click', () => {
    if (ksSession) void finishKnightScan();
  });

  // --- Snapshot: память на шахматную структуру, а не на цвет плиток. ---
  //
  // Своя доска на 64 клетки (тот же приём, что и мини-доски «Скана конём»,
  // но одна и в полный размер) — Board/Chessground тут не годится: во
  // время восстановления пользователь ставит фигуры на ЛЮБУЮ свободную
  // клетку, а не делает шахматный ход, и это не понятие, которое знает
  // chessops.
  type SnPhase = 'idle' | 'fixation' | 'exposure' | 'mask' | 'recall' | 'reveal' | 'done';
  interface SnPanelItem {
    color: Color;
    role: Role;
    placedAt: Key | null;
  }
  interface SnAttemptRecord {
    task: SnapshotTask;
    results: PieceResult[];
    summary: AttemptSummary;
    recallLatencyMs: number;
  }

  let snSession: SnapshotSession | null = null;
  let snIndex = 0;
  let snPhase: SnPhase = 'idle';
  let snArmed = false;
  let snRecallStartAt = 0;
  let snBoardWidthAtShow = 0;
  let snPanel: SnPanelItem[] = [];
  let snSelectedPanel: number | null = null;
  let snBlockedSquares: Set<Key> = new Set();
  let snAttempts: SnAttemptRecord[] = [];
  let snPhaseTimer: number | null = null;

  function snShuffle<T>(items: T[], rnd: () => number): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function snLater(fn: () => void, ms: number): void {
    snPhaseTimer = window.setTimeout(fn, ms);
  }
  function snClearTimer(): void {
    if (snPhaseTimer !== null) {
      window.clearTimeout(snPhaseTimer);
      snPhaseTimer = null;
    }
  }

  interface SnSquareHandle {
    key: Key;
    el: HTMLElement;
  }
  const snSquares: SnSquareHandle[] = [];
  const snBoardEl = el('div', { class: 'sn-board', role: 'group', 'aria-label': 'Доска Snapshot' });
  for (const key of ALL_SQUARES) {
    const f = key.charCodeAt(0) - 97;
    const r = Number(key[1]) - 1;
    const dark = (f + r) % 2 === 0;
    const sqEl = el('div', { class: `sn-sq ${dark ? 'sn-sq-dark' : 'sn-sq-light'}` });
    sqEl.addEventListener('click', () => snSquareClick(key));
    snBoardEl.append(sqEl);
    snSquares.push({ key, el: sqEl });
  }

  function snApplyOrientation(whiteBottom: boolean): void {
    for (const sq of snSquares) {
      const f = sq.key.charCodeAt(0) - 97;
      const r = Number(sq.key[1]) - 1;
      sq.el.style.gridColumn = String(whiteBottom ? f + 1 : 8 - f);
      sq.el.style.gridRow = String(whiteBottom ? 8 - r : r + 1);
    }
  }

  function snPieceEl(color: Color, role: Role, cls = ''): HTMLElement {
    const s = el('span', { class: `sn-piece ${cls}`, 'aria-hidden': 'true' });
    s.style.backgroundImage = `url("${SNAPSHOT_PIECE_ICON[color][role]}")`;
    return s;
  }

  function snClearBoard(): void {
    for (const sq of snSquares) {
      sq.el.innerHTML = '';
      sq.el.classList.remove('sn-outline-ok', 'sn-outline-bad', 'sn-outline-missed', 'sn-target');
    }
  }

  function snPaintFixation(): void {
    snClearBoard();
    const centerIdx = 27; // d5 — визуальный центр доски вне зависимости от ориентации
    snSquares[centerIdx].el.append(el('span', { class: 'sn-fixation-dot', 'aria-hidden': 'true' }));
  }

  function snPaintFull(pieces: PlacedPiece[]): void {
    snClearBoard();
    const bySquare = new Map(pieces.map((p) => [p.square, p]));
    for (const sq of snSquares) {
      const p = bySquare.get(sq.key);
      if (p) sq.el.append(snPieceEl(p.color, p.role));
    }
  }

  function snPaintMask(): void {
    snClearBoard();
    for (const sq of snSquares) sq.el.append(el('span', { class: 'sn-mask', 'aria-hidden': 'true' }));
  }

  function snPaintRecall(task: SnapshotTask): void {
    snClearBoard();
    const remaining = task.pieces.filter((p) => !task.removed.some((r) => r.square === p.square));
    const bySquare = new Map(remaining.map((p) => [p.square, p]));
    for (const sq of snSquares) {
      const orig = bySquare.get(sq.key);
      if (orig) {
        sq.el.append(snPieceEl(orig.color, orig.role));
        continue;
      }
      const placed = snPanel.find((p) => p.placedAt === sq.key);
      if (placed) sq.el.append(snPieceEl(placed.color, placed.role, 'sn-piece-user'));
    }
  }

  /** Итог: исходная позиция целиком + цветной контур на клетках исчезнувших фигур. */
  function snPaintReveal(task: SnapshotTask, results: PieceResult[]): void {
    snPaintFull(task.pieces);
    for (const r of results) {
      if (r.outcome === 'correct' && r.correctSquare) {
        snSquareByKey(r.correctSquare)?.el.classList.add('sn-outline-ok');
      } else if (r.outcome === 'missed' && r.correctSquare) {
        snSquareByKey(r.correctSquare)?.el.classList.add('sn-outline-missed');
      } else if (r.outcome === 'wrong-piece-right-square' && r.correctSquare) {
        snSquareByKey(r.correctSquare)?.el.classList.add('sn-outline-bad');
      } else if (r.outcome === 'right-piece-wrong-square') {
        if (r.correctSquare) snSquareByKey(r.correctSquare)?.el.classList.add('sn-outline-missed');
        if (r.chosenSquare) snSquareByKey(r.chosenSquare)?.el.classList.add('sn-outline-bad');
      } else if (r.outcome === 'extra' && r.chosenSquare) {
        snSquareByKey(r.chosenSquare)?.el.classList.add('sn-outline-bad');
      }
    }
  }

  function snSquareByKey(key: Key): SnSquareHandle | undefined {
    return snSquares.find((s) => s.key === key);
  }

  // --- Панель перемешанных фигур.

  const snPanelEl = el('div', { class: 'sn-panel' });

  function snRenderPanel(): void {
    snPanelEl.innerHTML = '';
    snPanel.forEach((item, i) => {
      if (item.placedAt) return; // уже на доске — из панели убрана
      const btn = el(
        'button',
        {
          class: `sn-panel-piece ${snSelectedPanel === i ? 'sn-panel-piece-armed' : ''}`,
          type: 'button',
          'aria-label': `${item.color === 'white' ? 'белая' : 'чёрная'} фигура`,
        },
        [snPieceEl(item.color, item.role)],
      );
      btn.addEventListener('click', () => snPanelClick(i));
      snPanelEl.append(btn);
    });
  }

  function snPanelClick(i: number): void {
    if (snPhase !== 'recall') return;
    snSelectedPanel = snSelectedPanel === i ? null : i;
    snRenderPanel();
  }

  function snSquareClick(key: Key): void {
    if (snPhase !== 'recall' || !snSession) return;
    // Клетка уже занята пользовательской фигурой — забираем её обратно в панель.
    const placedIdx = snPanel.findIndex((p) => p.placedAt === key);
    if (placedIdx !== -1) {
      snPanel[placedIdx].placedAt = null;
      snSelectedPanel = null;
      snRenderPanel();
      snPaintRecall(snSession.tasks[snIndex]);
      return;
    }
    if (snBlockedSquares.has(key)) return; // тут стоит фигура, которая не исчезала
    if (snSelectedPanel === null) return;
    snPanel[snSelectedPanel].placedAt = key;
    snSelectedPanel = null;
    snRenderPanel();
    snPaintRecall(snSession.tasks[snIndex]);
    snDoneBtn.disabled = snPanel.some((p) => !p.placedAt);
  }

  // --- Фазы одной попытки.

  function snShowTask(): void {
    snClearTimer();
    if (!snSession) return;
    const task = snSession.tasks[snIndex];
    if (!task) {
      void snFinish();
      return;
    }
    snPhase = 'fixation';
    renderSnVisibility();
    snArmed = true; // с этого момента потеря фокуса/ресайз аннулируют попытку
    snPanel = [];
    snSelectedPanel = null;
    snPromptEl.textContent = '';
    snApplyOrientation(task.orientation === 'white');
    snUpdateCounter();
    snDoneBtn.disabled = true;
    snPaintFixation();
    snLater(() => snShowExposure(task), 500);
  }

  function snShowExposure(task: SnapshotTask): void {
    snPhase = 'exposure';
    renderSnVisibility();
    snPromptEl.textContent = 'Запомни позицию.';
    snPaintFull(task.pieces);
    requestAnimationFrame(() => {
      if (snPhase !== 'exposure') return; // сессию успели прервать/аннулировать, пока ждали кадр
      snBoardWidthAtShow = snBoardEl.getBoundingClientRect().width;
      snLater(() => snShowMask(task), task.exposureMs);
    });
  }

  function snShowMask(task: SnapshotTask): void {
    snPhase = 'mask';
    renderSnVisibility();
    snPromptEl.textContent = '';
    snPaintMask();
    snLater(() => snShowRecall(task), 350);
  }

  function snShowRecall(task: SnapshotTask): void {
    snPhase = 'recall';
    renderSnVisibility();
    snPromptEl.textContent = 'Верни исчезнувшие фигуры на правильные клетки.';
    snPanel = snShuffle(
      task.removed.map((p) => ({ color: p.color, role: p.role, placedAt: null as Key | null })),
      Math.random,
    );
    snBlockedSquares = new Set(
      task.pieces.filter((p) => !task.removed.some((r) => r.square === p.square)).map((p) => p.square),
    );
    snRenderPanel();
    snPaintRecall(task);
    snDoneBtn.disabled = true;
    snRecallStartAt = performance.now();
  }

  function snFinishRecall(): void {
    if (snPhase !== 'recall' || !snSession) return;
    const task = snSession.tasks[snIndex];
    const recallLatencyMs = performance.now() - snRecallStartAt;
    const placements: Placement[] = snPanel
      .filter((p): p is SnPanelItem & { placedAt: Key } => p.placedAt !== null)
      .map((p) => ({ square: p.placedAt, color: p.color, role: p.role }));
    const results = scoreAttempt(task.removed, placements);
    const summary = summarizeAttempt(results);

    snArmed = false;
    snPhase = 'reveal';
    renderSnVisibility();
    snPaintReveal(task, results);
    snPromptEl.textContent =
      summary.accuracy === 1 ? 'Все фигуры на месте.' : `Верно: ${summary.fullyCorrect} из ${summary.total}.`;

    if (!task.warmup) {
      snAttempts.push({ task, results, summary, recallLatencyMs });
      void session?.record(snMeasurementData(task, results, summary, recallLatencyMs));
    }
    snLater(() => {
      snIndex++;
      snShowTask();
    }, 1000);
  }

  function snMeasurementData(
    task: SnapshotTask,
    results: PieceResult[],
    summary: AttemptSummary,
    recallLatencyMs: number,
  ): Record<string, unknown> {
    const remaining = task.pieces.filter((p) => !task.removed.some((r) => r.square === p.square));
    const placedPieces: PlacedPiece[] = results
      .filter((r) => r.chosenSquare !== null)
      .map((r) => ({ square: r.chosenSquare!, color: r.color, role: r.role }));
    return {
      kind: task.kind,
      pairId: task.pairId,
      difficulty: task.difficulty,
      fullyCorrect: summary.fullyCorrect,
      total: summary.total,
      accuracy: summary.accuracy,
      correct: summary.accuracy === 1,
      typeErrors: summary.typeErrors,
      spatialErrors: summary.spatialErrors,
      missed: summary.missed,
      extra: summary.extra,
      meanErrorDistance: summary.meanErrorDistance,
      recallLatencyMs,
      latencyMs: recallLatencyMs,
      exposureMs: task.exposureMs,
      originalFen: piecesToFen(task.pieces),
      reconstructedFen: piecesToFen([...remaining, ...placedPieces]),
      removedPieces: task.removed.map((p) => `${p.color[0]}${p.role[0]}${p.square}`),
      orientation: task.orientation,
      boardSize: snBoardWidthAtShow,
      inputMode: cal.inputMode,
      deviceProfile: cal.deviceProfile,
      seed: snSession?.seed ?? null,
    };
  }

  const snDoneBtn = el('button', { class: 'btn primary', type: 'button' }, ['Готово']);
  snDoneBtn.disabled = true;
  snDoneBtn.addEventListener('click', () => snFinishRecall());

  /** Вкладка потеряла фокус или доска сменила размер во время таймингов —
   * попытка не в счёт, начинаем ту же задачу заново с фазы фиксации. */
  function snInvalidate(): void {
    if (!snSession || !snArmed) return;
    snClearTimer();
    snShowTask();
  }
  function onSnVisibilityChange(): void {
    if (document.hidden) snInvalidate();
  }
  const snResizeObserver = new ResizeObserver(() => {
    if (!snSession || !snArmed || snPhase !== 'exposure') return;
    const w = snBoardEl.getBoundingClientRect().width;
    if (snBoardWidthAtShow && Math.abs(w - snBoardWidthAtShow) > 0.5) snInvalidate();
  });
  snResizeObserver.observe(snBoardEl);
  document.addEventListener('visibilitychange', onSnVisibilityChange);

  const snTitleEl = el('div', { class: 'ks-title' }, ['Snapshot']);
  const snIdleHint = el('p', { class: 'hint' }, [
    'Позиция показывается ненадолго, потом несколько фигур исчезают — верни их на верные клетки ',
    'по перемешанной панели снизу. Часть позиций — из реальных партий, часть — контрольные с той же ',
    'расстановкой фигур в случайном порядке; какая есть какая, не сообщается.',
  ]);
  const snCounterEl = el('div', { class: 'ks-counter hint' }, ['']);
  const snPromptEl = el('div', { class: 'prompt' }, ['']);
  const snStartBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const snStopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  snStopBtn.disabled = true;
  const snResultsHost = el('div', {});
  const snErrorReviewHost = el('div', {});

  function snUpdateCounter(): void {
    if (!snSession) return;
    const warmup = snSession.tasks[snIndex]?.warmup;
    const scoredSoFar = snSession.tasks.slice(0, snIndex).filter((t) => !t.warmup).length;
    snCounterEl.textContent = warmup
      ? `Разминка ${snIndex + 1} / ${SNAPSHOT_WARMUP}`
      : `Задание ${scoredSoFar + 1} / ${SNAPSHOT_SCORED}`;
  }

  function renderSnVisibility(): void {
    const active = snPhase !== 'idle' && snPhase !== 'done';
    snIdleHint.style.display = snPhase === 'idle' ? '' : 'none';
    snPromptEl.style.display = active ? '' : 'none';
    snCounterEl.style.display = active ? '' : 'none';
    snBoardEl.style.display = active ? '' : 'none';
    snPanelEl.style.display = snPhase === 'recall' ? '' : 'none';
    snDoneBtn.style.display = snPhase === 'recall' ? '' : 'none';
    snResultsHost.style.display = snPhase === 'done' ? '' : 'none';
    snErrorReviewHost.style.display = snPhase === 'done' ? '' : 'none';
    snStartBtn.style.display = active ? 'none' : '';
    snStartBtn.disabled = active;
    snStopBtn.disabled = !active;
  }

  function startSnapshot(): void {
    const seed = Math.floor(Math.random() * 2 ** 31);
    let s = seed;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const built = generateSnapshotSession(rnd, seed);
    if (!built) {
      promptEl.textContent = 'Не удалось собрать сессию Snapshot.';
      return;
    }
    snSession = built;
    snIndex = 0;
    snAttempts = [];
    snPhase = 'idle';
    planNextHost.innerHTML = '';
    session = new Session('reaction', 'snapshot', cal);
    renderSnVisibility();
    snShowTask();
    renderSnVisibility();
  }

  async function snFinish(): Promise<void> {
    snClearTimer();
    snArmed = false;
    snPhase = 'done';
    const meaningfulAttempts = snAttempts.filter((a) => a.task.kind === 'meaningful');
    const controlAttempts = snAttempts.filter((a) => a.task.kind === 'control');
    const accOf = (arr: SnAttemptRecord[]): number | null =>
      arr.length ? arr.reduce((s, a) => s + a.summary.accuracy, 0) / arr.length : null;
    const meaningfulAcc = accOf(meaningfulAttempts);
    const controlAcc = accOf(controlAttempts);
    const structuralEdgePp = meaningfulAcc !== null && controlAcc !== null ? (meaningfulAcc - controlAcc) * 100 : null;

    const byDiff = (d: SnapshotDifficulty) => snAttempts.filter((a) => a.task.difficulty === d);
    const distances = snAttempts.map((a) => a.summary.meanErrorDistance).filter((d): d is number => d !== null);
    const correctAttempts = snAttempts.filter((a) => a.summary.accuracy === 1);

    const summary: Record<string, number | string | null> = {
      attempts: snAttempts.length,
      meaningfulAccuracy: meaningfulAcc,
      controlAccuracy: controlAcc,
      structuralEdgePp,
      accuracyEasy: accOf(byDiff('easy')),
      accuracyMedium: accOf(byDiff('medium')),
      accuracyHard: accOf(byDiff('hard')),
      meanErrorDistance: distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null,
      medianRecallMs: median(correctAttempts.map((a) => a.recallLatencyMs)),
      seed: snSession?.seed ?? null,
    };

    const finishedId = session?.id ?? null;
    await session?.finish(summary);
    session = null;
    const finishedAttempts = snAttempts;
    snSession = null;
    await renderSnResults(summary, finishedId);
    renderSnErrorReview(finishedAttempts);
    renderSnVisibility();
    renderPlanNext();
  }

  /** Сводка + сравнение с прошлой сессией Snapshot на этом устройстве. */
  async function renderSnResults(
    summary: Record<string, number | string | null>,
    finishedId: string | null,
  ): Promise<void> {
    snResultsHost.innerHTML = '';
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const all = await allSessions();
    const prev =
      all
        .filter((s) => s.module === 'reaction' && s.mode === 'snapshot' && s.id !== finishedId)
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    const compare = (cur: number | null, prevKey: string, fmt: (v: number | null) => string): string => {
      if (!prev) return 'первая сессия Snapshot';
      const prevV = num(prev.summary[prevKey]);
      if (cur === null || prevV === null) return '';
      const better = fmt === fmtPct ? cur >= prevV : cur <= prevV;
      return `было ${fmt(prevV)} · ${better ? 'лучше' : 'хуже'} прошлой сессии`;
    };

    const edge = num(summary.structuralEdgePp);
    snResultsHost.append(
      metrics([
        metric('Игровые позиции', fmtPct(num(summary.meaningfulAccuracy)), compare(num(summary.meaningfulAccuracy), 'meaningfulAccuracy', fmtPct)),
        metric('Перемешанные', fmtPct(num(summary.controlAccuracy)), compare(num(summary.controlAccuracy), 'controlAccuracy', fmtPct)),
        metric('Структурное преимущество', edge === null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(0)} п.п.`),
      ]),
      el('p', { class: 'hint metrics-note' }, [
        // «Структурное преимущество» — это точность на реальных позициях
        // минус точность на перемешанных, в процентных пунктах. Не IQ,
        // не «память» вообще — только про то, помогает ли шахматная
        // структура запоминать быстрее случайного набора тех же фигур.
        'Структурное преимущество — насколько точнее держится в памяти настоящая структура партии по сравнению с тем же набором фигур вперемешку.',
      ]),
      table(
        ['Сложность', 'Точность'],
        (['easy', 'medium', 'hard'] as SnapshotDifficulty[]).map((d) => [
          d === 'easy' ? 'Лёгкая' : d === 'medium' ? 'Средняя' : 'Сложная',
          fmtPct(num(summary[`accuracy${d[0].toUpperCase()}${d.slice(1)}`])),
        ]),
      ),
      metrics([
        metric('Средняя ошибка расстояния', num(summary.meanErrorDistance) === null ? '—' : `${num(summary.meanErrorDistance)!.toFixed(1)} кл.`),
        metric('Медиана восстановления', fmtMs(num(summary.medianRecallMs))),
      ]),
    );
  }

  /** Разбор ошибок: пары «было / стало» по каждой попытке с промахом. */
  function renderSnErrorReview(attempts: SnAttemptRecord[]): void {
    snErrorReviewHost.innerHTML = '';
    const withErrors = attempts.filter((a) => a.summary.accuracy < 1);
    if (!withErrors.length) return;
    snErrorReviewHost.append(el('h3', { class: 'sn-review-title' }, ['Разбор ошибок']));
    for (const a of withErrors) {
      const remaining = a.task.pieces.filter((p) => !a.task.removed.some((r) => r.square === p.square));
      const placed: PlacedPiece[] = a.results
        .filter((r) => r.chosenSquare !== null)
        .map((r) => ({ square: r.chosenSquare!, color: r.color, role: r.role }));
      const orientationWhite = a.task.orientation === 'white';
      const row = el('div', { class: 'sn-review-row' }, [
        el('p', { class: 'hint sn-review-label' }, [
          `${a.task.kind === 'meaningful' ? 'Игровая позиция' : 'Перемешанная'} · ${
            a.task.difficulty === 'easy' ? 'лёгкая' : a.task.difficulty === 'medium' ? 'средняя' : 'сложная'
          } · верно ${a.summary.fullyCorrect} из ${a.summary.total}`,
        ]),
        el('div', { class: 'sn-review-pair' }, [
          snMiniBoard(a.task.pieces, orientationWhite, a.results),
          snMiniBoard([...remaining, ...placed], orientationWhite, a.results, true),
        ]),
      ]);
      snErrorReviewHost.append(row);
    }
  }

  function snMiniBoard(pieces: PlacedPiece[], orientationWhite: boolean, results: PieceResult[], isReconstructed = false): HTMLElement {
    const root = el('div', { class: 'sn-mini-board' });
    const bySquare = new Map(pieces.map((p) => [p.square, p]));
    for (const key of ALL_SQUARES) {
      const f = key.charCodeAt(0) - 97;
      const r = Number(key[1]) - 1;
      const dark = (f + r) % 2 === 0;
      const cell = el('div', { class: `sn-mini-sq ${dark ? 'sn-mini-sq-dark' : 'sn-mini-sq-light'}` });
      cell.style.gridColumn = String(orientationWhite ? f + 1 : 8 - f);
      cell.style.gridRow = String(orientationWhite ? 8 - r : r + 1);
      const p = bySquare.get(key);
      if (p) cell.append(snPieceEl(p.color, p.role));
      if (isReconstructed) {
        const res = results.find((x) => (x.chosenSquare === key && x.chosenSquare !== x.correctSquare) || (x.correctSquare === key && x.outcome === 'correct'));
        if (res?.outcome === 'correct') cell.classList.add('sn-outline-ok');
        else if (res && res.chosenSquare === key) cell.classList.add('sn-outline-bad');
      } else {
        const res = results.find((x) => x.correctSquare === key);
        if (res?.outcome === 'missed') cell.classList.add('sn-outline-missed');
      }
      root.append(cell);
    }
    return root;
  }

  snStartBtn.addEventListener('click', () => startSnapshot());
  snStopBtn.addEventListener('click', () => {
    if (snSession) void snFinish();
  });

  const snArea = el('div', { class: 'ks-area sn-area' }, [
    snTitleEl,
    snIdleHint,
    snPromptEl,
    snCounterEl,
    snBoardEl,
    snPanelEl,
    el('div', { class: 'row' }, [snStartBtn, snStopBtn, snDoneBtn]),
    snResultsHost,
    snErrorReviewHost,
  ]);

  function updateExerciseVisibility(): void {
    const isKs = exercise === 'knight-scan';
    const isSn = exercise === 'snapshot';
    timingControlsHost.style.display = isKs || isSn ? 'none' : '';
    boardArea.style.display = isKs || isSn ? 'none' : '';
    ksArea.style.display = isKs ? '' : 'none';
    snArea.style.display = isSn ? '' : 'none';
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
      updateExerciseVisibility();
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

  // Показ фигур/лимит времени управляют экспозицией на настоящей доске —
  // «Скану конём» они не нужны вовсе (ни доски, ни хода фигурой), поэтому
  // прячутся вместе с board-area, а не просто становятся неактивными.
  const boardArea = el('div', { class: 'board-area' }, [
    boardHost,
    el('div', { class: 'side' }, [
      promptEl,
      verdictEl,
      liveStats,
      el('div', { class: 'row' }, [startBtn, stopBtn]),
      planNextHost,
    ]),
  ]);

  const ksArea = el('div', { class: 'ks-area' }, [
    ksTitleEl,
    ksIdleHint,
    ksPromptEl,
    ksCounterEl,
    ksGrid,
    el('div', { class: 'row' }, [ksStartBtn, ksStopBtn]),
    ksResultsHost,
  ]);

  const timingControlsHost = el('div', {}, [
    el('div', { class: 'row' }, [el('label', {}, ['Показ фигур']), exposureSeg.root]),
    el('div', { class: 'row' }, [el('label', {}, ['Лимит времени']), timeLimitSeg.root]),
    el('p', { class: 'hint' }, [
      'Показ фигур — сколько времени видно позицию: после этого фигуры ',
      'скрываются, и решение идёт по памяти. Лимит времени — сколько ',
      'всего даётся на ответ: не успел, задание засчитывается как ',
      'несделанное. Настройки независимы.',
    ]),
  ]);

  root.append(
    panel('Упражнение', [exerciseSeg.root, timingControlsHost]),
    panel('Тренировка', [boardArea, ksArea, snArea]),
  );

  updateExerciseVisibility();
  renderKsVisibility();
  renderSnVisibility();
  renderLive();

  return () => {
    clearTimers();
    board.wrap.removeEventListener('pointerdown', onPointerDown);
    if (ksFeedbackTimer !== null) window.clearTimeout(ksFeedbackTimer);
    document.removeEventListener('keydown', onKsKeydown);
    document.removeEventListener('visibilitychange', onKsVisibilityChange);
    ksResizeObserver.disconnect();
    snClearTimer();
    document.removeEventListener('visibilitychange', onSnVisibilityChange);
    snResizeObserver.disconnect();
    if (ksSession) void finishKnightScan();
    else if (snSession) void snFinish();
    else if (session) void finish();
    board.destroy();
  };
}
