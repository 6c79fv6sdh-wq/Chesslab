import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, panel, segmented, statLine } from '../core/ui';
import { Session } from '../core/session';
import { fmtMs, fmtPct, median, p90 } from '../core/stats';
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

const TASKS_PER_SESSION = 8;

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

  let session: Session | null = null;
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
    // Пока ход соперника, пользователь ходить не может: movableColor не задан,
    // но premove разрешён — в этом весь смысл упражнения.
    const userToMove = p.turn === position.userColor;
    board.setPosition({
      fen: fenOf(p),
      orientation: position.userColor,
      turnColor: p.turn,
      movableColor: userToMove ? position.userColor : undefined,
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
    premoveUci = null;
    if (awaitingCancel) {
      finishCancel(true);
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

    // Соперник думает 1.2–2.2 секунды: за это время надо успеть решить.
    const think = 1200 + Math.random() * 1000;
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
        finishCancel(false, 'no-premove');
        return;
      }
      // Если за 3 секунды не снял, считаем провалом.
      later(() => {
        if (awaitingCancel) finishCancel(false);
      }, 3000);
      return;
    }

    paint(after, position, [from, to]);
    // Даём Chessground проиграть premove — так же, как это происходит на Lichess.
    const played = board.playPremove();
    later(() => evaluate(played), 60);
  }

  function evaluate(premovePlayed: boolean): void {
    if (!current || resolved) return;
    resolved = true;
    const position = current;
    const setLatency = premoveSetAt === null ? null : premoveSetAt - shownAt;

    let correct: boolean;
    let action: Attempt['action'];

    if (!premoveUci) {
      // Пользователь пропустил ход. Верно, если premove тут и не нужен.
      correct = !position.shouldPremove;
      action = 'skip';
    } else if (!position.shouldPremove) {
      correct = false;
      action = 'set';
    } else if (position.answerUci && premoveUci.startsWith(position.answerUci.slice(0, 4))) {
      correct = true;
      action = 'set';
    } else {
      correct = false;
      action = 'wrong-move';
    }

    // Ход применяем к позиции сами: доска должна остаться слепком FEN.
    if (premovePlayed && premoveUci && pos) {
      const mv = pos.isLegal(moveFromUci(premoveUci)) ? moveFromUci(premoveUci) : null;
      if (mv) {
        const after = pos.clone();
        after.play(mv);
        pos = after;
        paint(after, position, [premoveUci.slice(0, 2) as Key, premoveUci.slice(2, 4) as Key]);
      }
    }

    record({
      positionId: position.id,
      mode: position.mode,
      correct,
      setLatencyMs: setLatency,
      cancelLatencyMs: null,
      action,
      premoveUci,
    });
  }

  function finishCancel(cancelled: boolean, reason?: 'no-premove'): void {
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
      premoveUci,
    });
  }

  function record(a: Attempt): void {
    attempts.push(a);
    void session?.record({ ...a });
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

  function renderLive(): void {
    const n = attempts.length;
    const correct = attempts.filter((a) => a.correct).length;
    const setTimes = attempts
      .map((a) => a.setLatencyMs)
      .filter((v): v is number => v !== null);
    const cancelTimes = attempts
      .map((a) => a.cancelLatencyMs)
      .filter((v): v is number => v !== null);
    liveStats.innerHTML = '';
    liveStats.append(
      statLine([
        ['Заданий', `${n} / ${TASKS_PER_SESSION}`],
        ['Точность', n ? fmtPct(correct / n) : '—'],
        ['Медиана постановки', fmtMs(median(setTimes))],
        ['Медиана снятия', fmtMs(median(cancelTimes))],
      ]),
    );
  }

  async function finish(): Promise<void> {
    clearTimers();
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
    });
    session = null;
    current = null;
    promptEl.textContent = 'Сессия закончена. Результат записан.';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  // --- Снятие premove: кнопка, пробел, Esc, правая кнопка мыши.
  function cancelPremoveByUser(): void {
    if (!board.hasPremove() && !premoveUci) return;
    board.cancelPremove();
    premoveUci = null;
    if (awaitingCancel) finishCancel(true);
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

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const stopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  stopBtn.disabled = true;

  startBtn.addEventListener('click', () => {
    attempts.length = 0;
    const pool = positionsOf(mode);
    queue = shuffle(pool, Math.random);
    while (queue.length < TASKS_PER_SESSION && pool.length) {
      queue = queue.concat(shuffle(pool, Math.random));
    }
    queue = queue.slice(0, TASKS_PER_SESSION);
    session = new Session('premove', mode, cal);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    renderLive();
    nextTask();
  });

  stopBtn.addEventListener('click', () => {
    if (session) void finish();
  });

  root.append(
    panel('Режим', [modeSeg.root]),
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
