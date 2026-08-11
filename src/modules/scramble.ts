import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, panel, segmented, statLine } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { fmtMs, median, p90 } from '../core/stats';
import {
  BOT_LABELS,
  Clocks,
  ENGINE_LEVELS,
  OPPONENT_LABELS,
  OUTCOME_LABELS,
  botDelay,
  chooseMove,
  eloOfLevel,
  formatClock,
  levelLabel,
  type BotProfile,
  type EngineLevel,
  type OpponentKind,
  type Outcome,
} from './scramble-logic';
import { engineSupported, sharedEngine } from '../core/engine';
import {
  INITIAL_FEN,
  checkedColor,
  dests,
  fenOf,
  keyOf,
  moveFromKeys,
  moveFromUci,
  opposite,
  posFromFen,
  type Chess,
} from '../core/chess';
import type { Color, Key } from 'chessground/types';
import { stepAfter } from './today-plan';

type ClockSetting = '15' | '10' | '5';

const CLOCK_LABELS: Record<ClockSetting, string> = {
  '15': '15 секунд',
  '10': '10 секунд',
  '5': '5 секунд',
};

export function mountScramble(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  let clockSetting: ClockSetting = '15';
  let profile: BotProfile = 'fast';
  let userColor: Color = 'white';
  let opponent: OpponentKind = engineSupported() ? 'engine' : 'simple';
  let level: EngineLevel = 2200;
  const cameFromPlan = consumePlanNavigation();

  root.append(el('h1', {}, ['Цейтнот']));

  const boardHost = el('div', { class: 'board-host' });
  const board = new Board(boardHost, {
    orientation: userColor,
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
    premovable: true,
  });

  const userClockEl = el('div', { class: 'clock' }, ['—']);
  const botClockEl = el('div', { class: 'clock' }, ['—']);
  const promptEl = el('div', { class: 'prompt' }, ['Выбери часы и соперника, потом «Старт».']);
  const engineStatusEl = el('div', { class: 'hint' }, ['']);
  const liveStats = el('div', {});
  const planNextHost = el('div', { class: 'plan-next-host' });

  let session: Session | null = null;
  let pos: Chess = posFromFen(INITIAL_FEN);
  let clocks: Clocks | null = null;
  let running = false;
  let userMoveStartedAt = 0;
  const userMoveTimes: number[] = [];
  let tickHandle: number | null = null;
  const timers: number[] = [];
  /** Номер попытки старта: отменяет отсчёт, если нажали «Отмена» или ушли со вкладки. */
  let startToken = 0;

  function later(fn: () => void, ms: number): void {
    timers.push(window.setTimeout(fn, ms));
  }

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
  }

  function botColor(): Color {
    return opposite(userColor);
  }

  function paint(lastMove?: Key[]): void {
    const userToMove = running && pos.turn === userColor;
    // Цвет задаём всегда, иначе premove на часах соперника не поставить:
    // Chessground проверяет movable.color при выборе фигуры для премува.
    board.setPosition({
      fen: fenOf(pos),
      orientation: userColor,
      turnColor: pos.turn,
      movableColor: running ? userColor : undefined,
      dests: userToMove ? dests(pos) : new Map(),
      lastMove,
      check: checkedColor(pos),
      viewOnly: !running,
    });
    board.api.set({ premovable: { enabled: running && !userToMove } });
  }

  function renderClocks(): void {
    if (!clocks) return;
    userClockEl.textContent = formatClock(clocks.get(userColor));
    botClockEl.textContent = formatClock(clocks.get(botColor()));
    const active = clocks.activeColor();
    userClockEl.classList.toggle('active', active === userColor);
    botClockEl.classList.toggle('active', active === botColor());
    userClockEl.classList.toggle('flagged', clocks.get(userColor) <= 0);
    botClockEl.classList.toggle('flagged', clocks.get(botColor()) <= 0);
  }

  function startTicking(): void {
    stopTicking();
    tickHandle = window.setInterval(() => {
      if (!clocks || !running) return;
      clocks.tick();
      renderClocks();
      const flagged = clocks.flagged();
      if (flagged) {
        void end(flagged === userColor ? 'flag-user' : 'flag-bot');
      }
    }, 50);
  }

  function stopTicking(): void {
    if (tickHandle !== null) {
      window.clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function checkGameEnd(): boolean {
    if (pos.isCheckmate()) {
      // Мат поставила сторона, которая только что сходила.
      void end(pos.turn === userColor ? 'mate-bot' : 'mate-user');
      return true;
    }
    if (pos.isStalemate() || pos.isInsufficientMaterial()) {
      void end('draw');
      return true;
    }
    return false;
  }

  function onMove(orig: Key, dest: Key): void {
    if (!running || !clocks || pos.turn !== userColor) return;
    const move = moveFromKeys(pos, orig, dest);
    if (!move) {
      paint();
      return;
    }
    // Время думанья пользователя списывается с его часов в этот момент.
    const spent = performance.now() - userMoveStartedAt;
    userMoveTimes.push(spent);
    clocks.switchTo(botColor());
    renderClocks();

    pos.play(move);
    paint([orig, dest]);
    void session?.record({
      side: 'user',
      moveMs: spent,
      ply: userMoveTimes.length,
      clockLeftMs: clocks.get(userColor),
    });
    renderLive();

    if (clocks.flagged()) {
      void end(clocks.flagged() === userColor ? 'flag-user' : 'flag-bot');
      return;
    }
    if (checkGameEnd()) return;
    scheduleBotMove();
  }

  function scheduleBotMove(): void {
    if (!running || !clocks) return;
    promptEl.textContent = 'Ход соперника.';
    const delay = botDelay(profile, Math.random);
    later(() => {
      void playBotMove();
    }, delay);
  }

  /** Ход соперника: движком либо простым ботом. */
  async function playBotMove(): Promise<void> {
    if (!running || !clocks || pos.turn !== botColor()) return;
    let move = null as ReturnType<typeof chooseMove>;

    if (opponent === 'engine') {
      try {
        const engine = sharedEngine();
        await engine.setStrength(eloOfLevel(level));
        // Времени на счёт даём не больше, чем осталось у бота на часах.
        const budget = Math.max(40, Math.min(300, clocks.get(botColor()) * 0.15));
        const uci = await engine.bestMove(fenOf(pos), { movetimeMs: Math.round(budget) });
        if (!running || pos.turn !== botColor()) return;
        if (uci) {
          const parsed = moveFromUci(uci);
          if (pos.isLegal(parsed)) move = parsed;
        }
      } catch (e) {
        engineStatusEl.textContent = `Движок недоступен, играю простым ботом: ${(e as Error).message}`;
        move = chooseMove(pos, profile, Math.random);
      }
    }
    if (!move) move = chooseMove(pos, profile, Math.random);

    {
      if (!running || !clocks || pos.turn !== botColor()) return;
      if (!move) {
        checkGameEnd();
        return;
      }
      // Время бота списывается с часов бота.
      clocks.switchTo(userColor);
      renderClocks();
      if (clocks.flagged()) {
        void end(clocks.flagged() === userColor ? 'flag-user' : 'flag-bot');
        return;
      }
      pos.play(move);
      paint([keyOf(move.from), keyOf(move.to)]);
      userMoveStartedAt = performance.now();
      promptEl.textContent = 'Твой ход.';
      if (checkGameEnd()) return;
      // Заранее поставленный premove играется сразу, как на Lichess.
      later(() => {
        if (running && pos.turn === userColor) board.playPremove();
      }, 20);
    }
  }

  function renderLive(): void {
    liveStats.innerHTML = '';
    liveStats.append(
      statLine([
        ['Своих ходов', String(userMoveTimes.length)],
        ['Медиана на ход', fmtMs(median(userMoveTimes))],
        ['P90 на ход', fmtMs(p90(userMoveTimes))],
      ]),
    );
  }

  async function end(outcome: Outcome): Promise<void> {
    if (!running) return;
    running = false;
    stopTicking();
    clearTimers();
    clocks?.stop();
    renderClocks();
    paint();
    promptEl.textContent = `Партия окончена: ${OUTCOME_LABELS[outcome]}.`;
    await session?.finish({
      outcome,
      outcomeLabel: OUTCOME_LABELS[outcome],
      opponent,
      engineElo: opponent === 'engine' ? (eloOfLevel(level) ?? 'max') : '',
      bot: profile,
      clockMs: Number(clockSetting) * 1000,
      userColor,
      moves: userMoveTimes.length,
      medianMoveMs: median(userMoveTimes),
      p90MoveMs: p90(userMoveTimes),
    });
    session = null;
    startBtn.disabled = false;
    resignBtn.disabled = true;
    renderPlanNext();
  }

  /** Часть дневной тренировки «Сегодня» — см. пояснение в motorics.ts. */
  function renderPlanNext(): void {
    planNextHost.innerHTML = '';
    if (!cameFromPlan) return;
    const next = stepAfter('scramble', new Date());
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

  const clockSeg = segmented<ClockSetting>(
    (Object.keys(CLOCK_LABELS) as ClockSetting[]).map((k) => ({ value: k, label: CLOCK_LABELS[k] })),
    clockSetting,
    (v) => {
      if (!running) clockSetting = v;
    },
  );

  const opponentSeg = segmented<OpponentKind>(
    (Object.keys(OPPONENT_LABELS) as OpponentKind[]).map((k) => ({ value: k, label: OPPONENT_LABELS[k] })),
    opponent,
    (v) => {
      if (running) return;
      opponent = v;
      levelRow.style.display = v === 'engine' ? '' : 'none';
      updateEngineHint();
    },
  );

  const parseLevel = (v: string): EngineLevel => (v === 'max' ? 'max' : (Number(v) as EngineLevel));

  const levelSeg = segmented<string>(
    [
      ...ENGINE_LEVELS.map((e) => ({ value: String(e), label: levelLabel(e) })),
      { value: 'max', label: levelLabel('max') },
    ],
    String(level),
    (v) => {
      if (running) return;
      level = parseLevel(v);
      updateEngineHint();
    },
  );

  const levelRow = el('div', { class: 'row' }, [el('label', {}, ['Сила движка']), levelSeg.root]);

  // engineStatusEl зарезервирован под реальные ошибки движка (не загрузился,
  // недоступен), поэтому при обычном переключении настроек просто чистим его.
  function updateEngineHint(): void {
    engineStatusEl.textContent = '';
  }

  const botSeg = segmented<BotProfile>(
    (Object.keys(BOT_LABELS) as BotProfile[]).map((k) => ({ value: k, label: BOT_LABELS[k] })),
    profile,
    (v) => {
      if (!running) profile = v;
    },
  );

  const colorSeg = segmented<Color>(
    [
      { value: 'white', label: 'Белыми' },
      { value: 'black', label: 'Чёрными' },
    ],
    userColor,
    (v) => {
      if (running) return;
      userColor = v;
      board.setOrientation(v);
      paint();
    },
  );

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const resignBtn = el('button', { class: 'btn', type: 'button' }, ['Сдаться']);
  resignBtn.disabled = true;

  const wait = (ms: number) => new Promise<void>((resolve) => later(() => resolve(), ms));

  /**
   * Партия начинается с отсчёта готовности.
   *
   * Раньше часы включались прямо по нажатию «Старт»: на пятнадцати секундах
   * достаточно было замешкаться на пару мгновений, чтобы флаг упал до первого
   * хода. Доска после этого замирала, и выглядело так, будто ходить нельзя.
   * Заодно дожидаемся загрузки движка, чтобы соперник не думал о вечном.
   */
  async function beginGame(): Promise<void> {
    const token = ++startToken;
    const cancelled = () => token !== startToken;
    clearTimers();
    userMoveTimes.length = 0;
    planNextHost.innerHTML = '';
    pos = posFromFen(INITIAL_FEN);
    clocks = new Clocks(Number(clockSetting) * 1000);
    running = false;
    startBtn.disabled = true;
    resignBtn.disabled = false;
    board.cancelPremove();
    paint();
    renderClocks();
    renderLive();

    if (opponent === 'engine') {
      promptEl.textContent = 'Загружаю движок…';
      try {
        await sharedEngine().start();
        await sharedEngine().setStrength(eloOfLevel(level));
        await sharedEngine().newGame();
      } catch (e) {
        engineStatusEl.textContent = `Движок не загрузился, играю простым ботом: ${(e as Error).message}`;
        opponent = 'simple';
      }
    }
    // Партию могли отменить, пока грузился движок.
    if (cancelled()) return;

    for (const n of [3, 2, 1]) {
      promptEl.textContent = `Готовность… ${n}`;
      await wait(600);
      if (cancelled()) return;
    }

    const mode =
      opponent === 'engine' ? `sf${eloOfLevel(level) ?? 'max'}:${clockSetting}s` : `${profile}:${clockSetting}s`;
    session = new Session('scramble', mode, measuredCalibration(cal, board.size));

    running = true;
    paint();
    clocks.start('white');
    startTicking();
    if (pos.turn === userColor) {
      userMoveStartedAt = performance.now();
      promptEl.textContent = 'Твой ход.';
    } else {
      scheduleBotMove();
    }
  }

  startBtn.addEventListener('click', () => {
    void beginGame();
  });

  resignBtn.addEventListener('click', () => {
    if (running) {
      void end('aborted');
      return;
    }
    // Отмена во время отсчёта готовности: партия ещё не началась.
    startToken++;
    clearTimers();
    startBtn.disabled = false;
    resignBtn.disabled = true;
    promptEl.textContent = 'Отменено до начала партии.';
    paint();
  });

  board.setOptions({ onMove });

  root.append(
    panel('Настройки партии', [
      el('div', { class: 'row' }, [el('label', {}, ['Часы']), clockSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Соперник']), opponentSeg.root]),
      levelRow,
      el('div', { class: 'row' }, [el('label', {}, ['Темп хода']), botSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Играю']), colorSeg.root]),
      engineStatusEl,
      el('p', { class: 'hint' }, ['Без добавления времени, обеим сторонам поровну.']),
    ]),
    panel('Партия', [
      el('div', { class: 'board-area' }, [
        boardHost,
        el('div', { class: 'side' }, [
          el('div', { class: 'clock-row' }, [
            el('div', { class: 'col grow' }, [
              el('span', { class: 'clock-label' }, ['Соперник']),
              botClockEl,
            ]),
            el('div', { class: 'col grow' }, [el('span', { class: 'clock-label' }, ['Ты']), userClockEl]),
          ]),
          promptEl,
          liveStats,
          el('div', { class: 'row' }, [startBtn, resignBtn]),
          planNextHost,
        ]),
      ]),
    ]),
  );

  paint();
  renderLive();
  levelRow.style.display = opponent === 'engine' ? '' : 'none';
  updateEngineHint();
  // Прогреваем движок заранее, чтобы первый ход не ждал загрузки 7 МБ.
  if (opponent === 'engine') void sharedEngine().start().catch(() => undefined);

  return () => {
    startToken++;
    stopTicking();
    clearTimers();
    if (running) void end('aborted');
    board.destroy();
  };
}
