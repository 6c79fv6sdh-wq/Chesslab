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
  type PremovePosition,
} from '../data/premove-positions';
import {
  checkedColor,
  dests,
  fenOf,
  moveFromUci,
  opposite,
  posFromFen,
  uciOf,
  type Chess,
} from '../core/chess';
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
  /** Сколько даётся на снятие premove в задании «cancel», мс. */
  cancelMs: number;
  hint: string;
}

/**
 * Разброс времени внутри режима намеренный: с фиксированной паузой ход
 * соперника ловится по ритму, а не по позиции, и упражнение вырождается.
 *
 * «Профи» — ровно то, что было до появления переключателя: 1.2–2.2 с на
 * ход и 3 с на снятие. Менять его нельзя, иначе прошлые замеры перестанут
 * сравниваться с новыми.
 */
export const DIFFICULTIES: Record<Difficulty, DifficultySpec> = {
  amateur: {
    label: 'Любитель',
    thinkMinMs: 4500,
    thinkJitterMs: 1000,
    cancelMs: 5000,
    hint: 'Около 5 секунд на поиск хода и premove — можно спокойно посчитать.',
  },
  pro: {
    label: 'Профи',
    thinkMinMs: 1200,
    thinkJitterMs: 1000,
    cancelMs: 3000,
    hint: 'Соперник думает 1,2–2,2 секунды. Обычный турнирный темп.',
  },
  extreme: {
    label: 'Extreme',
    thinkMinMs: 600,
    thinkJitterMs: 500,
    cancelMs: 1800,
    hint: 'Около секунды на решение. Только на скорость реакции.',
  },
};

interface Attempt {
  positionId: string;
  mode: PremoveMode;
  correct: boolean;
  /** Время постановки premove от показа позиции, мс. */
  setLatencyMs: number | null;
  /** Время снятия premove от появления неожиданного хода, мс. */
  cancelLatencyMs: number | null;
  /** Решение пользователя: поставил, пропустил, снял, не снял. */
  action: 'set' | 'skip' | 'cancelled' | 'not-cancelled' | 'wrong-move';
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
   * Сложность, с которой началась текущая сессия. Отдельно от `difficulty`
   * потому, что переключатель менять посреди сессии нельзя: половина
   * попыток оказалась бы в других условиях, чем вторая, а в разборе они
   * лежали бы вперемешку. Переключатель на время сессии блокируется.
   */
  let sessionDifficulty: Difficulty = difficulty;
  const cameFromPlan = consumePlanNavigation();

  root.append(el('h1', {}, ['Premove']));

  const boardHost = el('div', { class: 'board-host' });
  const board = new Board(boardHost, {
    orientation: 'white',
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
    premovable: true,
  });

  const promptEl = el('div', { class: 'prompt' }, ['Выбери режим и нажми «Старт».']);
  const verdictEl = el('div', { class: 'prompt' }, ['']);
  const liveStats = el('div', {});
  const commentEl = el('p', { class: 'hint' }, ['']);
  const planNextHost = el('div', { class: 'plan-next-host' });

  let session: Session | null = null;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let queue: PremovePosition[] = [];
  let current: PremovePosition | null = null;
  let pos: Chess | null = null;
  let shownAt = 0;
  let premoveSetAt: number | null = null;
  let premoveUci: string | null = null;
  let opponentMovedAt: number | null = null;
  let awaitingCancel = false;
  let resolved = false;
  const attempts: Attempt[] = [];
  const timers: number[] = [];

  function later(fn: () => void, ms: number): void {
    timers.push(window.setTimeout(fn, ms));
  }

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
  }

  function paint(p: Chess, position: PremovePosition, lastMove?: Key[]): void {
    const userToMove = p.turn === position.userColor;
    // movableColor задаём ВСЕГДА, даже когда ходит соперник: Chessground
    // разрешает premove только если movable.color совпадает с цветом фигуры.
    // Обычный ход при этом всё равно заблокирован, потому что isMovable
    // дополнительно требует turnColor === цвет фигуры.
    board.setPosition({
      fen: fenOf(p),
      orientation: position.userColor,
      turnColor: p.turn,
      movableColor: position.userColor,
      dests: userToMove ? dests(p) : new Map(),
      lastMove,
      check: checkedColor(p),
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
    if (!current || resolved) return;
    premoveSetAt = performance.now();
    premoveUci = `${orig}${dest}`;
    verdictEl.textContent = `Premove ${orig}${dest} поставлен.`;
    verdictEl.className = 'prompt';
  }

  function onPremoveUnset(): void {
    if (!current || resolved) return;
    // Как и в playPremove(), фиксируем значение до сброса: cancelMove()
    // тоже шлёт unset синхронно, а finishCancel() ниже должен записать
    // именно тот UCI, что был снят, а не null.
    const uciAtUnset = premoveUci;
    premoveUci = null;
    if (awaitingCancel) {
      finishCancel(true, undefined, uciAtUnset);
    }
  }

  function nextTask(): void {
    clearTimers();
    if (!session) return;
    const position = queue.shift();
    if (!position) {
      void finish();
      return;
    }
    current = position;
    pos = posFromFen(position.fen);
    premoveSetAt = null;
    premoveUci = null;
    opponentMovedAt = null;
    awaitingCancel = false;
    resolved = false;
    board.cancelPremove();
    commentEl.textContent = '';
    verdictEl.textContent = '';
    verdictEl.className = 'prompt';

    paint(pos, position);
    promptEl.textContent = promptFor(position);
    shownAt = performance.now();

    // Сколько соперник «думает» — и есть время на решение (см. DIFFICULTIES).
    const spec = DIFFICULTIES[sessionDifficulty];
    const think = spec.thinkMinMs + Math.random() * spec.thinkJitterMs;
    later(() => opponentMoves(), think);
  }

  function promptFor(position: PremovePosition): string {
    const side = position.userColor === 'white' ? 'белыми' : 'чёрными';
    switch (position.mode) {
      case 'forced-capture':
        return `Играешь ${side}. Соперник вот-вот сыграет ${position.expectedSan}. Поставь ответное взятие заранее.`;
      case 'safe-unsafe':
        return `Играешь ${side}. Реши: ставить premove или осознанно пропустить.`;
      case 'cancel':
        return `Играешь ${side}. Ставь ожидаемый ответ, но будь готов снять его.`;
    }
  }

  function opponentMoves(): void {
    if (!current || !pos || resolved) return;
    const position = current;
    const isCancelTask = position.mode === 'cancel' && !!position.unexpectedUci;
    const uci = isCancelTask ? position.unexpectedUci! : position.expectedUci;
    const move = moveFromUci(uci);
    const after = pos.clone();
    after.play(move);
    pos = after;
    opponentMovedAt = performance.now();

    const from = uci.slice(0, 2) as Key;
    const to = uci.slice(2, 4) as Key;

    if (isCancelTask) {
      // Неожиданный ход: premove надо снять как можно быстрее.
      awaitingCancel = true;
      paint(after, position, [from, to]);
      promptEl.textContent = `Соперник сыграл неожиданно: ${position.unexpectedSan}. Снимай premove!`;
      if (!board.hasPremove() && !premoveUci) {
        // Premove не ставился — засчитывать нечего.
        finishCancel(false, 'no-premove', premoveUci);
        return;
      }
      // Не успел снять за отведённое режимом время — провал.
      later(() => {
        if (awaitingCancel) finishCancel(false, undefined, premoveUci);
      }, DIFFICULTIES[sessionDifficulty].cancelMs);
      return;
    }

    paint(after, position, [from, to]);
    // Chessground сбрасывает state.premovable.current и шлёт events.unset
    // синхронно внутри playPremove() — даже когда премув успешно сыгран.
    // Поэтому запоминаем UCI ДО вызова, иначе onPremoveUnset() обнулит
    // premoveUci раньше, чем evaluate() успеет его прочитать, и любой
    // верно поставленный премув засчитается как «не поставлен».
    const premoveAtMove = premoveUci;
    // Даём Chessground проиграть premove — так же, как это происходит на Lichess.
    const played = board.playPremove();
    later(() => evaluate(played, premoveAtMove), 60);
  }

  function evaluate(premovePlayed: boolean, premoveUciAtMove: string | null): void {
    if (!current || resolved) return;
    resolved = true;
    const position = current;
    const setLatency = premoveSetAt === null ? null : premoveSetAt - shownAt;

    let correct: boolean;
    let action: Attempt['action'];

    if (!premoveUciAtMove) {
      // Пользователь пропустил ход. Верно, если premove тут и не нужен.
      correct = !position.shouldPremove;
      action = 'skip';
    } else if (!position.shouldPremove) {
      correct = false;
      action = 'set';
    } else if (position.answerUci && premoveUciAtMove.startsWith(position.answerUci.slice(0, 4))) {
      correct = true;
      action = 'set';
    } else {
      correct = false;
      action = 'wrong-move';
    }

    // Ход применяем к позиции сами: доска должна остаться слепком FEN.
    if (premovePlayed && premoveUciAtMove && pos) {
      const mv = pos.isLegal(moveFromUci(premoveUciAtMove)) ? moveFromUci(premoveUciAtMove) : null;
      if (mv) {
        const after = pos.clone();
        after.play(mv);
        pos = after;
        paint(after, position, [premoveUciAtMove.slice(0, 2) as Key, premoveUciAtMove.slice(2, 4) as Key]);
      }
    }

    record({
      positionId: position.id,
      mode: position.mode,
      correct,
      setLatencyMs: setLatency,
      cancelLatencyMs: null,
      action,
      premoveUci: premoveUciAtMove,
    });
  }

  function finishCancel(cancelled: boolean, reason: 'no-premove' | undefined, uci: string | null): void {
    if (!current || resolved) return;
    resolved = true;
    awaitingCancel = false;
    const position = current;
    const latency =
      cancelled && opponentMovedAt !== null ? performance.now() - opponentMovedAt : null;
    record({
      positionId: position.id,
      mode: position.mode,
      correct: cancelled,
      setLatencyMs: premoveSetAt === null ? null : premoveSetAt - shownAt,
      cancelLatencyMs: latency,
      action: reason === 'no-premove' ? 'skip' : cancelled ? 'cancelled' : 'not-cancelled',
      premoveUci: uci,
    });
  }

  function record(a: Attempt): void {
    attempts.push(a);
    // Сложность пишем в каждый замер: время на решение у режимов разное,
    // и без этой пометки быстрые попытки на «Любителе» смешались бы в
    // разборе с попытками на «Extreme», где условия совсем другие.
    void session?.record({ ...a, difficulty: sessionDifficulty });
    verdictEl.textContent = verdictText(a);
    verdictEl.className = a.correct ? 'prompt verdict-ok' : 'prompt verdict-bad';
    commentEl.textContent = current?.comment ?? '';
    board.cancelPremove();
    renderLive();
    later(() => nextTask(), 1400);
  }

  function verdictText(a: Attempt): string {
    if (a.mode === 'cancel') {
      if (a.action === 'skip') return 'Premove не ставился, снимать было нечего.';
      return a.correct
        ? `Снято за ${fmtMs(a.cancelLatencyMs)}.`
        : 'Premove не снят — на доске остался чужой ход.';
    }
    if (a.action === 'skip') return a.correct ? 'Верный пропуск.' : 'Здесь надо было ставить premove.';
    if (a.action === 'wrong-move') return 'Не тот ход.';
    return a.correct ? `Верно, за ${fmtMs(a.setLatencyMs)}.` : 'Здесь premove ставить не стоило.';
  }

  /** Тот же расчёт, что в motorics.ts: без старта — пусто, после финиша — заморожено. */
  function elapsedMs(): number | null {
    if (startedAt === null) return null;
    return (finishedAt ?? performance.now()) - startedAt;
  }

  /**
   * Единый вид результатов — как в motorics.ts, reaction.ts и openings.ts.
   * «Скорость» — та же приоритетная задержка, что и в сводке «Прогресса»
   * (см. primaryLatency в data-summary.ts): для снятого premove важно
   * время снятия, иначе — время постановки.
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

  // --- Снятие premove: кнопка, пробел, Esc, правая кнопка мыши.
  function cancelPremoveByUser(): void {
    if (!board.hasPremove() && !premoveUci) return;
    // board.cancelPremove() обычно уже вызывает onPremoveUnset() синхронно
    // (chessground шлёт unset изнутри cancelMove()), который сам разрулит
    // awaitingCancel. Локальная копия ниже — подстраховка на случай рассинхрона
    // (premoveUci выставлен у нас, а current в chessground уже пуст, и unset
    // не шлётся): тогда resolved ещё false и мы обязаны закрыть попытку сами.
    const uciAtCancel = premoveUci;
    board.cancelPremove();
    premoveUci = null;
    if (awaitingCancel) finishCancel(true, undefined, uciAtCancel);
  }

  const cancelBtn = el('button', { class: 'btn danger', type: 'button' }, ['Снять premove']);
  cancelBtn.addEventListener('click', cancelPremoveByUser);

  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === 'Escape') {
      if (session) {
        e.preventDefault();
        cancelPremoveByUser();
      }
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    cancelPremoveByUser();
  };
  const onAuxDown = (e: MouseEvent) => {
    if (e.button === 2) cancelPremoveByUser();
  };
  window.addEventListener('keydown', onKey);
  boardHost.addEventListener('contextmenu', onContextMenu);
  boardHost.addEventListener('mousedown', onAuxDown);

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

  /** Пока идёт сессия, сложность не меняем — см. sessionDifficulty. */
  function setDifficultyEnabled(on: boolean): void {
    for (const b of difficultySeg.root.querySelectorAll('button')) {
      (b as HTMLButtonElement).disabled = !on;
    }
  }

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
          el('div', { class: 'row' }, [startBtn, stopBtn, cancelBtn]),
          commentEl,
          el('p', { class: 'hint' }, [
            'Снять premove: кнопка, пробел, Esc или правая кнопка мыши.',
          ]),
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
export function opponentColorOf(p: PremovePosition): 'white' | 'black' {
  return opposite(p.userColor);
}

export { uciOf };
