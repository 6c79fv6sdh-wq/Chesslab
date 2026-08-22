import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, metric, metrics, panel, segmented } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { fmtMs, fmtPct, fmtSec, median, p90, plural } from '../core/stats';
import { stepAfter } from './today-plan';
import {
  PREMOVE_MODE_LABELS,
  positionsOf,
  type PremoveMode,
  type PremoveTask,
} from '../data/premove-positions';
import { dests, fenOf, moveFromUci, opposite, posFromFen, uciOf, type Chess } from '../core/chess';
import type { Key } from 'chessground/types';

// export: сверяется тестом с порогом полноценного завершения в today-plan.ts
export const TASKS_PER_SESSION = 8;

/** Сложность = сколько времени даётся, пока соперник «думает». */
export type Difficulty = 'amateur' | 'pro' | 'extreme';

export interface DifficultySpec {
  label: string;
  /** Нижняя граница раздумий соперника, мс. */
  thinkMinMs: number;
  /** Разброс сверх нижней границы, мс. */
  thinkJitterMs: number;
  hint: string;
}

/**
 * Разброс времени внутри режима намеренный: с фиксированной паузой ход
 * соперника ловится по ритму, а не по позиции, и упражнение вырождается.
 *
 * «Профи» — ровно то, что было до появления переключателя: 1.2–2.2 с на
 * ход. Менять нельзя, иначе прошлые замеры перестанут сравниваться с новыми.
 */
export const DIFFICULTIES: Record<Difficulty, DifficultySpec> = {
  amateur: {
    label: 'Любитель',
    thinkMinMs: 4500,
    thinkJitterMs: 1000,
    hint: 'Около 5 секунд на ход соперника — можно спокойно посчитать.',
  },
  pro: {
    label: 'Профи',
    thinkMinMs: 1200,
    thinkJitterMs: 1000,
    hint: 'Соперник думает 1,2–2,2 секунды. Обычный турнирный темп.',
  },
  extreme: {
    label: 'Extreme',
    thinkMinMs: 600,
    thinkJitterMs: 500,
    hint: 'Около секунды на решение. Только на скорость реакции.',
  },
};

interface Attempt {
  positionId: string;
  mode: PremoveMode;
  correct: boolean;
  /** Форсированное взятие: время постановки premove. Safe/Unsafe: время решения. */
  setLatencyMs: number | null;
  /** Отмена: время решения «оставить/снять», принятого ДО хода соперника. */
  cancelLatencyMs: number | null;
  action: 'set' | 'skip' | 'wrong-move' | 'kept' | 'removed';
  premoveUci: string | null;
}

/** Перемешивание Фишера-Йетса на переданном генераторе. */
export function shuffle<T>(items: T[], rnd: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function mountPremove(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  let mode: PremoveMode = 'forced-capture';
  let difficulty: Difficulty = 'pro';
  /**
   * Сложность, с которой началась текущая сессия. Отдельно от `difficulty`,
   * потому что переключатель менять посреди сессии нельзя.
   */
  let sessionDifficulty: Difficulty = difficulty;
  const cameFromPlan = consumePlanNavigation();

  root.append(el('h1', {}, ['Премувы']));

  const boardHost = el('div', { class: 'board-host' });
  const board = new Board(boardHost, {
    orientation: 'white',
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
    premovable: true,
    // Правая кнопка на этой доске занята своим смыслом — снять premove,
    // как на настоящем Lichess. Разметка стрелками сюда не заводится,
    // иначе один и тот же жест значил бы разное на разных страницах.
    drawable: false,
  });

  const promptEl = el('div', { class: 'prompt' }, ['Выбери режим и нажми «Старт».']);
  const verdictEl = el('div', { class: 'prompt' }, ['']);
  const liveStats = el('div', {});
  const commentEl = el('p', { class: 'hint' }, ['']);
  const sourceEl = el('p', { class: 'hint premove-source' }, ['']);
  const planNextHost = el('div', { class: 'plan-next-host' });

  let session: Session | null = null;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let queue: PremoveTask[] = [];
  let current: PremoveTask | null = null;
  let pos: Chess | null = null;
  let shownAt = 0;
  let premoveSetAt: number | null = null;
  let premoveUci: string | null = null;
  let resolved = false;
  /** Только режим «Отмена»: решение уже заблокировано и ход ещё не показан. */
  let cancelDecided = false;
  let cancelDecision: 'keep' | 'remove' | null = null;
  const attempts: Attempt[] = [];
  const timers: number[] = [];

  function later(fn: () => void, ms: number): void {
    timers.push(window.setTimeout(fn, ms));
  }

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
  }

  function paint(p: Chess, task: PremoveTask, lastMove?: Key[]): void {
    const userToMove = p.turn === task.userColor;
    // movableColor задаём ВСЕГДА, даже когда ходит соперник: Chessground
    // разрешает премув только если movable.color совпадает с цветом фигуры.
    // Обычный ход при этом всё равно заблокирован, потому что isMovable
    // дополнительно требует turnColor === цвет фигуры.
    board.setPosition({
      fen: fenOf(p),
      orientation: task.userColor,
      turnColor: p.turn,
      movableColor: task.userColor,
      dests: userToMove ? dests(p) : new Map(),
      lastMove,
      check: p.isCheck() ? p.turn : false,
    });
    board.api.set({
      premovable: {
        enabled: !userToMove,
        events: {
          set: (orig, dest) => onPremoveSet(orig, dest),
          unset: () => onPremoveUnset(),
        },
      },
    });
  }

  function onPremoveSet(orig: Key, dest: Key): void {
    if (!current || resolved || current.mode !== 'forced-capture') return;
    premoveSetAt = performance.now();
    premoveUci = `${orig}${dest}`;
    verdictEl.textContent = `Премув ${orig}${dest} поставлен.`;
    verdictEl.className = 'prompt';
  }

  function onPremoveUnset(): void {
    premoveUci = null;
  }

  function updateModeUi(t: PremoveTask): void {
    fcControls.style.display = t.mode === 'forced-capture' ? '' : 'none';
    suControls.style.display = t.mode === 'safe-unsafe' ? '' : 'none';
    cxControls.style.display = t.mode === 'cancel' ? '' : 'none';
    suSetBtn.disabled = false;
    suSkipBtn.disabled = false;
    cxKeepBtn.disabled = false;
    cxRemoveBtn.disabled = false;
  }

  function nextTask(): void {
    clearTimers();
    if (!session) return;
    const task = queue.shift();
    if (!task) {
      void finish();
      return;
    }
    current = task;
    pos = posFromFen(task.fen);
    premoveSetAt = null;
    premoveUci = null;
    resolved = false;
    cancelDecided = false;
    cancelDecision = null;
    board.cancelPremove();
    board.setPremoveDests(undefined);
    commentEl.textContent = '';
    sourceEl.textContent = '';
    verdictEl.textContent = '';
    verdictEl.className = 'prompt';

    paint(pos, task);
    promptEl.textContent = promptFor(task);
    updateModeUi(task);
    shownAt = performance.now();

    const spec = DIFFICULTIES[sessionDifficulty];
    const think = () => spec.thinkMinMs + Math.random() * spec.thinkJitterMs;

    if (task.mode === 'forced-capture') {
      // Разрешённые клетки — из позиции ПОСЛЕ ожидаемого хода, а не по
      // геометрии Chessground: см. Board.setPremoveDests().
      const afterExpected = pos.clone();
      afterExpected.play(moveFromUci(task.expectedUci));
      board.setPremoveDests(dests(afterExpected));
      later(() => opponentMoves(), think());
    } else if (task.mode === 'cancel') {
      // Премув уже стоит на доске — пользователь его не рисует сам.
      const from = task.answerUci.slice(0, 2) as Key;
      const to = task.answerUci.slice(2, 4) as Key;
      board.presetPremove(from, to);
      premoveUci = task.answerUci;
      premoveSetAt = shownAt;
      // Не среагировал за отведённое время — как и в реальности, ничего
      // не делать значит оставить премув стоять.
      later(() => lockCancelDecision('keep'), think());
    }
    // safe-unsafe: ждём клика по кнопке, без таймера — это не гонка на
    // реакцию, а разбор позиции.
  }

  function promptFor(task: PremoveTask): string {
    const side = task.userColor === 'white' ? 'белыми' : 'чёрными';
    switch (task.mode) {
      case 'forced-capture':
        return `Играешь ${side}. Соперник вот-вот сыграет ${task.expectedSan}. Поставь ответное взятие заранее.`;
      case 'safe-unsafe':
        return `Играешь ${side}. Ожидается ${task.expectedSan}. Предполагаемый premove: ${task.answerSan}. Ставить или пропустить?`;
      case 'cancel':
        return `Играешь ${side}. Премув уже поставлен. Пока соперник думает, реши: оставить или снять.`;
    }
  }

  // --- Режим 1: Ответное взятие. ---

  function opponentMoves(): void {
    if (!current || !pos || resolved || current.mode !== 'forced-capture') return;
    const task = current;
    const move = moveFromUci(task.expectedUci);
    const after = pos.clone();
    after.play(move);
    pos = after;

    const from = task.expectedUci.slice(0, 2) as Key;
    const to = task.expectedUci.slice(2, 4) as Key;
    paint(after, task, [from, to]);

    // Chessground сбрасывает state.premovable.current и шлёт events.unset
    // синхронно внутри playPremove() — даже когда премув успешно сыгран.
    // Поэтому запоминаем UCI ДО вызова, иначе onPremoveUnset() обнулит
    // premoveUci раньше, чем evaluateForcedCapture() успеет его прочитать.
    const premoveAtMove = premoveUci;
    const played = board.playPremove();
    later(() => evaluateForcedCapture(played, premoveAtMove), 60);
  }

  function evaluateForcedCapture(premovePlayed: boolean, premoveUciAtMove: string | null): void {
    if (!current || resolved) return;
    resolved = true;
    const task = current;
    const setLatency = premoveSetAt === null ? null : premoveSetAt - shownAt;

    let correct: boolean;
    let action: Attempt['action'];
    if (!premoveUciAtMove) {
      correct = false; // в пуле форсированного взятия премув нужен всегда
      action = 'skip';
    } else if (premoveUciAtMove.startsWith(task.answerUci.slice(0, 4))) {
      correct = true;
      action = 'set';
    } else {
      correct = false;
      action = 'wrong-move';
    }

    if (premovePlayed && premoveUciAtMove && pos) {
      const mv = pos.isLegal(moveFromUci(premoveUciAtMove)) ? moveFromUci(premoveUciAtMove) : null;
      if (mv) {
        const after = pos.clone();
        after.play(mv);
        pos = after;
        paint(after, task, [premoveUciAtMove.slice(0, 2) as Key, premoveUciAtMove.slice(2, 4) as Key]);
      }
    }

    record(
      {
        positionId: task.id,
        mode: task.mode,
        correct,
        setLatencyMs: setLatency,
        cancelLatencyMs: null,
        action,
        premoveUci: premoveUciAtMove,
      },
      task,
    );
  }

  // --- Режим 2: Safe / Unsafe. ---

  function decideSafeUnsafe(setIt: boolean): void {
    if (!current || resolved || current.mode !== 'safe-unsafe' || !pos) return;
    resolved = true;
    const task = current;
    const decisionLatency = performance.now() - shownAt;
    const correct = setIt === !!task.shouldPremove;

    // Ход всё равно доигрываем — чтобы на экране осталась настоящая
    // партия, а не застывшая позиция «до».
    const move = moveFromUci(task.expectedUci);
    const after = pos.clone();
    after.play(move);
    pos = after;
    const from = task.expectedUci.slice(0, 2) as Key;
    const to = task.expectedUci.slice(2, 4) as Key;
    paint(after, task, [from, to]);

    record(
      {
        positionId: task.id,
        mode: task.mode,
        correct,
        setLatencyMs: decisionLatency,
        cancelLatencyMs: null,
        action: setIt ? 'set' : 'skip',
        premoveUci: setIt ? task.answerUci : null,
      },
      task,
    );
  }

  // --- Режим 3: Отмена. ---

  function lockCancelDecision(decision: 'keep' | 'remove'): void {
    if (!current || resolved || current.mode !== 'cancel' || cancelDecided) return;
    cancelDecided = true;
    cancelDecision = decision;
    cxKeepBtn.disabled = true;
    cxRemoveBtn.disabled = true;
    if (decision === 'remove') {
      // Убираем визуально СРАЗУ, до хода соперника — решение принято.
      board.cancelPremove();
      premoveUci = null;
    }
    later(() => revealCancelOutcome(), 250);
  }

  function revealCancelOutcome(): void {
    if (!current || !pos || current.mode !== 'cancel') return;
    const task = current;
    const decisionLatency = shownAt === 0 ? null : performance.now() - shownAt;
    const playedUci = task.correctAction === 'remove' ? task.unexpectedUci! : task.expectedUci;
    const move = moveFromUci(playedUci);
    const after = pos.clone();
    after.play(move);
    pos = after;
    const from = playedUci.slice(0, 2) as Key;
    const to = playedUci.slice(2, 4) as Key;
    paint(after, task, [from, to]);

    if (cancelDecision === 'keep') {
      // Премув стоял и стоит — он реально исполняется, как на Lichess.
      const played = board.playPremove();
      if (played && pos) {
        const answerMove = moveFromUci(task.answerUci);
        if (pos.isLegal(answerMove)) {
          const afterAnswer = pos.clone();
          afterAnswer.play(answerMove);
          pos = afterAnswer;
          paint(afterAnswer, task, [
            task.answerUci.slice(0, 2) as Key,
            task.answerUci.slice(2, 4) as Key,
          ]);
        }
      }
    }

    resolved = true;
    const correct = cancelDecision === task.correctAction;
    record(
      {
        positionId: task.id,
        mode: task.mode,
        correct,
        setLatencyMs: null,
        cancelLatencyMs: decisionLatency,
        action: cancelDecision === 'keep' ? 'kept' : 'removed',
        premoveUci: task.answerUci,
      },
      task,
    );
  }

  // --- Общее: снятие премува кнопкой/пробелом/Esc/правой кнопкой. ---
  // В режиме «Отмена» это ровно решение «снять», принятое ДО хода
  // соперника, — то же самое действие, что и кнопка «Снять».
  // В режиме «Форсированное взятие» — отказ от собственного, ещё не
  // сыгранного premove. В Safe/Unsafe живого премува нет — no-op.
  function handleCancelGesture(): void {
    if (!session || !current) return;
    if (current.mode === 'cancel') {
      lockCancelDecision('remove');
      return;
    }
    if (current.mode === 'forced-capture' && board.hasPremove()) {
      board.cancelPremove();
      premoveUci = null;
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === 'Escape') {
      if (session) {
        e.preventDefault();
        handleCancelGesture();
      }
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    handleCancelGesture();
  };
  const onAuxDown = (e: MouseEvent) => {
    if (e.button === 2) handleCancelGesture();
  };
  window.addEventListener('keydown', onKey);
  boardHost.addEventListener('contextmenu', onContextMenu);
  boardHost.addEventListener('mousedown', onAuxDown);

  function record(a: Attempt, task: PremoveTask): void {
    attempts.push(a);
    // Сложность пишем в каждый замер: время на решение у режимов разное,
    // и без этой пометки быстрые попытки на «Любителе» смешались бы в
    // разборе с попытками на «Extreme». Режимы между собой тоже не
    // смешиваются — Session заведена на конкретный mode (см. startBtn),
    // а summarizeModule (data-summary.ts) группирует замеры по mode сам.
    void session?.record({ ...a, difficulty: sessionDifficulty });
    verdictEl.textContent = verdictText(a, task);
    verdictEl.className = a.correct ? 'prompt verdict-ok' : 'prompt verdict-bad';
    commentEl.textContent = task.comment;
    sourceEl.textContent = `${task.source.white} — ${task.source.black}, ${task.source.event}, ${task.source.date}`;
    board.cancelPremove();
    renderLive();
    later(() => nextTask(), 1400);
  }

  function verdictText(a: Attempt, task: PremoveTask): string {
    if (a.mode === 'cancel') {
      if (a.correct) return a.action === 'kept' ? 'Верно: премув стоило оставить.' : 'Верно: премув стоило снять.';
      return a.action === 'kept' ? 'Премув надо было снять.' : 'Премув стоило оставить.';
    }
    if (a.mode === 'safe-unsafe') {
      if (a.correct) return task.shouldPremove ? 'Верно: это безопасный premove.' : 'Верно: премув здесь опасен.';
      return task.shouldPremove ? 'Это был безопасный premove — стоило ставить.' : 'Это опасный premove — стоило пропустить.';
    }
    if (a.action === 'skip') return 'Здесь нужен был премув.';
    if (a.action === 'wrong-move') return 'Не тот ход.';
    return a.correct ? `Верно, за ${fmtMs(a.setLatencyMs)}.` : 'Неверно.';
  }

  /** Тот же расчёт, что в motorics.ts: без старта — пусто, после финиша — заморожено. */
  function elapsedMs(): number | null {
    if (startedAt === null) return null;
    return (finishedAt ?? performance.now()) - startedAt;
  }

  /**
   * Единый вид результатов — как в motorics.ts, reaction.ts и openings.ts.
   * «Скорость» — приоритетная задержка (см. primaryLatency в
   * data-summary.ts): для отмены важно время решения, иначе — время
   * постановки/выбора.
   */
  function renderLive(): void {
    const n = attempts.length;
    const correct = attempts.filter((a) => a.correct);
    const primary = correct
      .map((a) => a.cancelLatencyMs ?? a.setLatencyMs)
      .filter((v): v is number => v !== null);
    const missCount = n - correct.length;
    liveStats.innerHTML = '';
    liveStats.append(
      metrics([
        metric('Скорость', fmtSec(median(primary))),
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
    finishedAt = performance.now();
    const n = attempts.length;
    const setTimes = attempts.map((a) => a.setLatencyMs).filter((v): v is number => v !== null);
    const cancelTimes = attempts
      .map((a) => a.cancelLatencyMs)
      .filter((v): v is number => v !== null);
    await session?.finish({
      attempts: n,
      accuracy: n ? attempts.filter((a) => a.correct).length / n : null,
      medianSetMs: median(setTimes),
      p90SetMs: p90(setTimes),
      medianCancelMs: median(cancelTimes),
      difficulty: sessionDifficulty,
    });
    session = null;
    current = null;
    promptEl.textContent = 'Сессия закончена. Результат записан.';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setDifficultyEnabled(true);
    setModeEnabled(true);
    renderLive();
    renderPlanNext();
  }

  /** Часть дневной тренировки «Сегодня» — см. пояснение в motorics.ts. */
  function renderPlanNext(): void {
    planNextHost.innerHTML = '';
    if (!cameFromPlan) return;
    const next = stepAfter('premove', new Date());
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

  const modeSeg = segmented<PremoveMode>(
    (Object.keys(PREMOVE_MODE_LABELS) as PremoveMode[]).map((m) => ({
      value: m,
      label: PREMOVE_MODE_LABELS[m],
    })),
    mode,
    (v) => {
      mode = v;
      if (!session) promptEl.textContent = `Режим: ${PREMOVE_MODE_LABELS[v]}. Нажми «Старт».`;
    },
  );

  function setModeEnabled(on: boolean): void {
    for (const b of modeSeg.root.querySelectorAll('button')) (b as HTMLButtonElement).disabled = !on;
  }

  const difficultyHint = el('p', { class: 'hint' }, [DIFFICULTIES[difficulty].hint]);
  const difficultySeg = segmented<Difficulty>(
    (Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => ({
      value: d,
      label: DIFFICULTIES[d].label,
    })),
    difficulty,
    (v) => {
      difficulty = v;
      difficultyHint.textContent = DIFFICULTIES[v].hint;
    },
  );

  /** Пока идёт сессия, сложность и режим не меняем — половина попыток
   * оказалась бы в других условиях, чем вторая. */
  function setDifficultyEnabled(on: boolean): void {
    for (const b of difficultySeg.root.querySelectorAll('button')) {
      (b as HTMLButtonElement).disabled = !on;
    }
  }

  // --- Кнопки по режимам. ---

  const fcCancelBtn = el('button', { class: 'btn', type: 'button' }, ['Отменить свой premove']);
  fcCancelBtn.addEventListener('click', handleCancelGesture);
  const fcControls = el('div', { class: 'row' }, [fcCancelBtn]);

  const suSetBtn = el('button', { class: 'btn primary', type: 'button' }, ['Поставить']);
  const suSkipBtn = el('button', { class: 'btn', type: 'button' }, ['Не ставить']);
  suSetBtn.addEventListener('click', () => decideSafeUnsafe(true));
  suSkipBtn.addEventListener('click', () => decideSafeUnsafe(false));
  const suControls = el('div', { class: 'row' }, [suSetBtn, suSkipBtn]);

  const cxKeepBtn = el('button', { class: 'btn primary', type: 'button' }, ['Оставить']);
  const cxRemoveBtn = el('button', { class: 'btn danger', type: 'button' }, ['Снять']);
  cxKeepBtn.addEventListener('click', () => lockCancelDecision('keep'));
  cxRemoveBtn.addEventListener('click', () => lockCancelDecision('remove'));
  const cxControls = el('div', { class: 'row' }, [
    cxKeepBtn,
    cxRemoveBtn,
    el('p', { class: 'hint' }, ['Снять: кнопка, пробел, Esc или правая кнопка мыши.']),
  ]);
  fcControls.style.display = 'none';
  suControls.style.display = 'none';
  cxControls.style.display = 'none';

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const stopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  stopBtn.disabled = true;

  startBtn.addEventListener('click', () => {
    attempts.length = 0;
    startedAt = performance.now();
    finishedAt = null;
    planNextHost.innerHTML = '';
    const pool = positionsOf(mode);
    queue = shuffle(pool, Math.random);
    while (queue.length < TASKS_PER_SESSION && pool.length) {
      queue = queue.concat(shuffle(pool, Math.random));
    }
    queue = queue.slice(0, TASKS_PER_SESSION);
    session = new Session('premove', mode, measuredCalibration(cal, board.size));
    sessionDifficulty = difficulty;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setDifficultyEnabled(false);
    setModeEnabled(false);
    renderLive();
    nextTask();
  });

  stopBtn.addEventListener('click', () => {
    if (session) void finish();
  });

  root.append(
    panel('Режим', [modeSeg.root]),
    panel('Сложность', [difficultySeg.root, difficultyHint]),
    panel('Тренировка', [
      el('div', { class: 'board-area' }, [
        boardHost,
        el('div', { class: 'side' }, [
          promptEl,
          verdictEl,
          liveStats,
          el('div', { class: 'row' }, [startBtn, stopBtn]),
          fcControls,
          suControls,
          cxControls,
          commentEl,
          sourceEl,
          planNextHost,
        ]),
      ]),
    ]),
  );

  renderLive();

  return () => {
    clearTimers();
    window.removeEventListener('keydown', onKey);
    boardHost.removeEventListener('contextmenu', onContextMenu);
    boardHost.removeEventListener('mousedown', onAuxDown);
    if (session) void finish();
    board.destroy();
  };
}

/** Используется тестами: сторона, которая ходит в позиции задания. */
export function opponentColorOf(p: PremoveTask): 'white' | 'black' {
  return opposite(p.userColor);
}

export { uciOf };
