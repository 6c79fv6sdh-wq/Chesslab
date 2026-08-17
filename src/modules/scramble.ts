import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, panel, segmented, statLine } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { fmtMs, median, p90 } from '../core/stats';
import { Clocks, OUTCOME_LABELS, botDelay, chooseMove, formatClock, type Outcome } from './scramble-logic';
import {
  BOTS,
  DEFAULT_BOT,
  MAX_CANDIDATES,
  bot as botOf,
  sampleByTemperature,
  type BotDef,
} from '../core/bots';
import { DEFAULT_TIME_CONTROL, TIME_CONTROLS, timeControl } from '../core/timecontrol';
import { GameAutosave, buildPgn, newGameRecord, type GameRecord } from '../core/games';
import { getGame } from '../core/db';
import { maiaAvailable, maiaCandidates, warmUpMaia } from '../core/maia';
import { engineSupported, sharedEngine, type Analyser } from '../core/engine';
import { chooseBlindMove, BEGINNER_PROFILE } from '../core/blind-bot';
import { consumeResumeGame } from './resume';
import {
  INITIAL_FEN,
  checkedColor,
  dests,
  fenOf,
  keyOf,
  makeSan,
  moveFromKeys,
  moveFromUci,
  opposite,
  posFromFen,
  uciOf,
  type Chess,
  type NormalMove,
} from '../core/chess';
import type { Color, Key } from 'chessground/types';
import { stepAfter } from './today-plan';

/**
 * Задержка «раздумья» бота. Раньше это был отдельный переключатель темпа,
 * но с человекоподобными соперниками темп — часть характера бота, а не
 * независимая настройка: Maia думает как человек и «стрелять» ходами
 * ей незачем. Оставили одну спокойную вилку.
 */
const THINK_MIN_MS = 260;
const THINK_MAX_MS = 900;

/**
 * Путь до аватара бота: public/avatars/<id>.webp. Файла может не быть —
 * это ожидаемо (набор аватарок собирается отдельно от кода), тогда <img>
 * молча падает по onerror и остаётся кружок-заглушка с первой буквой
 * имени, без сломанной иконки браузера.
 *
 * Спецификация для тех, кто готовит картинки: квадрат, ≥256×256, WebP
 * (см. public/showcase/*.webp — тот же формат уже в проекте), лицо/морда
 * крупно и по центру — итоговый кружок мелкий, широкий кадр в нём не
 * читается. Имя файла — id бота из core/bots.ts (blind-beginner,
 * blind-student, maia-novice, maia-800, maia-1000, maia-1100, sf-1400,
 * sf-1800, sf-2200, sf-max) — так что подключение сводится к тому, чтобы
 * просто положить файл в public/avatars/, никакой правки кода не нужно.
 */
function botAvatarUrl(id: string): string {
  return `avatars/${id}.webp`;
}

/**
 * Соперник — аватар с кольцом силы, а не текстовая пилюля: лицо бота
 * видно с одного взгляда, кольцо вокруг него — не декор, а доля шкалы
 * силы (по порядку в BOTS, от Дебютанта до Движка максимум). Ряд не
 * переносится (flex-wrap: nowrap в .bot-picker) — все десять помещаются
 * в одну строку на обычном экране, а на телефоне лента просто скроллится
 * вбок, тем же приёмом, что и витрина скриншотов (.carousel-viewport).
 */
function botPicker(
  bots: BotDef[],
  value: string,
  onChange: (v: string) => void,
): { root: HTMLElement; set: (v: string) => void } {
  const root = el('div', { class: 'bot-picker' });
  const buttons = new Map<string, HTMLButtonElement>();
  const set = (v: string) => {
    for (const [id, b] of buttons) b.classList.toggle('active', id === v);
  };
  bots.forEach((b, i) => {
    const pct = bots.length > 1 ? Math.round((i / (bots.length - 1)) * 100) : 100;
    const ring = el('div', { class: 'bot-avatar-ring' });
    ring.style.setProperty('--bot-pct', `${pct}%`);
    const img = el('img', { src: botAvatarUrl(b.id), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.remove(), { once: true });
    // aria-hidden: буква видна только пока не подгрузилась/не нашлась
    // картинка, а до тех пор доступное имя кнопки не должно превращаться
    // в «Н Новичок» — оно и так есть в .bot-avatar-name ниже.
    const face = el('div', { class: 'bot-avatar-face' }, [
      el('span', { class: 'bot-avatar-fallback', 'aria-hidden': 'true' }, [b.name.charAt(0)]),
      img,
    ]);
    ring.append(face);
    const btn = el('button', { class: 'bot-avatar', type: 'button' }, [
      ring,
      el('span', { class: 'bot-avatar-name' }, [b.name]),
    ]);
    btn.addEventListener('click', () => {
      set(b.id);
      onChange(b.id);
    });
    buttons.set(b.id, btn);
    root.append(btn);
  });
  set(value);
  return { root, set };
}

export function mountScramble(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  let tcId = DEFAULT_TIME_CONTROL;
  let botId = DEFAULT_BOT;
  let userColor: Color = 'white';
  const cameFromPlan = consumePlanNavigation();

  // Заголовок экрана — то же слово, что и вкладка над ним («Спарринг»):
  // раньше здесь стояло старое имя «Цейтнот», и на телефоне оно читалось
  // прямо под подсвеченной вкладкой «Спарринг» — два разных слова для
  // одного и того же смотрелись как ошибка. id 'scramble' и маршрут
  // #scramble не трогаем — на них ссылаются история партий и план дня.
  root.append(el('h1', {}, ['Спарринг']));

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
  const promptEl = el('div', { class: 'prompt' }, ['Выбери соперника и контроль, потом «Старт».']);
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
  let startToken = 0;

  /** Текущая сохраняемая партия. Пишется после каждого хода. */
  let game: GameRecord | null = null;
  const autosave = new GameAutosave();

  const rnd = () => Math.random();

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

  function currentBot(): BotDef {
    return botOf(botId);
  }

  function paint(lastMove?: Key[]): void {
    const userToMove = running && pos.turn === userColor;
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
    if (!clocks || clocks.untimed) {
      userClockEl.textContent = '—';
      botClockEl.textContent = '—';
      return;
    }
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
    if (clocks?.untimed) return;
    tickHandle = window.setInterval(() => {
      if (!clocks || !running) return;
      clocks.tick();
      renderClocks();
      const flagged = clocks.flagged();
      if (flagged) void end(flagged === userColor ? 'flag-user' : 'flag-bot');
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
      void end(pos.turn === userColor ? 'mate-bot' : 'mate-user');
      return true;
    }
    if (pos.isStalemate() || pos.isInsufficientMaterial()) {
      void end('draw');
      return true;
    }
    return false;
  }

  /**
   * Записать сделанный ход в сохраняемую партию.
   *
   * Вызывается ДО pos.play: SAN считается по позиции перед ходом.
   * Сохранение идёт после каждого полухода — партию бросают на середине
   * постоянно, и именно недоигранные потом доигрывают.
   */
  function recordMove(move: NormalMove, spentMs: number): void {
    if (!game) return;
    const san = makeSan(pos, move);
    const mover = pos.turn;
    game.moves.push({
      uci: uciOf(move),
      san,
      spentMs: Math.round(spentMs),
      clockLeftMs: clocks && !clocks.untimed ? Math.round(clocks.get(mover)) : null,
    });
  }

  /** Обновить снимок партии в базе: позиция, часы, PGN. */
  function persist(): void {
    if (!game) return;
    game.fen = fenOf(pos);
    game.clockLeftMs =
      clocks && !clocks.untimed
        ? { white: Math.round(clocks.get('white')), black: Math.round(clocks.get('black')) }
        : null;
    game.pgn = buildPgn(game);
    autosave.save(game);
  }

  function onMove(orig: Key, dest: Key): void {
    if (!running || !clocks || pos.turn !== userColor) return;
    const move = moveFromKeys(pos, orig, dest);
    if (!move) {
      paint();
      return;
    }
    const spent = performance.now() - userMoveStartedAt;
    userMoveTimes.push(spent);

    recordMove(move, spent);
    clocks.switchTo(botColor());
    renderClocks();
    pos.play(move);
    paint([orig, dest]);
    persist();

    void session?.record({
      side: 'user',
      moveMs: spent,
      ply: userMoveTimes.length,
      clockLeftMs: clocks.untimed ? null : clocks.get(userColor),
    });
    renderLive();

    const flagged = clocks.flagged();
    if (flagged) {
      void end(flagged === userColor ? 'flag-user' : 'flag-bot');
      return;
    }
    if (checkGameEnd()) return;
    scheduleBotMove();
  }

  function scheduleBotMove(): void {
    if (!running || !clocks) return;
    promptEl.textContent = 'Ход соперника.';
    const delay = botDelay('human2200', rnd);
    later(() => void playBotMove(), Math.min(THINK_MAX_MS, Math.max(THINK_MIN_MS, delay)));
  }

  /**
   * Ход бота.
   *
   * Maia: берём кандидатов из политики сети и сэмплируем по температуре
   * бота. Никакого «ухудшения движка» — все кандидаты уже человеческие.
   * Blind: движок полной силы, но с намеренно малой глубиной поиска —
   * решение принимает chooseBlindMove (core/blind-bot.ts), не движок.
   * Stockfish: обычный поиск с ограничением силы.
   * Если Maia недоступна (нет изоляции страницы) — честно откатываемся
   * на Stockfish и говорим об этом, а не молчим.
   */
  async function playBotMove(): Promise<void> {
    if (!running || !clocks || pos.turn !== botColor()) return;
    const def = currentBot();
    let move: NormalMove | null = null;
    const thinkStartedAt = performance.now();

    const tryUci = (uci: string | null | undefined): NormalMove | null => {
      if (!uci || uci === '(none)') return null;
      try {
        const parsed = moveFromUci(uci);
        return pos.isLegal(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };

    if (def.kind === 'maia' && maiaAvailable()) {
      try {
        const width = def.temperature ? (def.candidates ?? MAX_CANDIDATES) : 1;
        const cands = await maiaCandidates(fenOf(pos), def.net!, width);
        if (!running || pos.turn !== botColor()) return;
        move = tryUci(sampleByTemperature(cands, def.temperature ?? 0, rnd, width));
      } catch (e) {
        engineStatusEl.textContent = `Maia не запустилась (${(e as Error).message}), играю движком.`;
      }
    }

    if (!move && def.kind === 'blind' && engineSupported()) {
      try {
        const engine = sharedEngine();
        const analyser: Analyser = (fen, opts) => engine.analyse(fen, opts);
        const blindMove = await chooseBlindMove(analyser, pos, def.blindProfile ?? BEGINNER_PROFILE, rnd);
        if (!running || pos.turn !== botColor()) return;
        move = blindMove;
      } catch (e) {
        engineStatusEl.textContent = `Движок недоступен, играю простым ботом: ${(e as Error).message}`;
      }
    }

    if (!move && (def.kind === 'stockfish' || def.kind === 'maia') && engineSupported()) {
      try {
        const engine = sharedEngine();
        await engine.setStrength(def.kind === 'stockfish' ? (def.elo ?? null) : 1400);
        const budget = clocks.untimed
          ? 300
          : Math.max(40, Math.min(600, clocks.get(botColor()) * 0.05));
        const uci = await engine.bestMove(fenOf(pos), { movetimeMs: Math.round(budget) });
        if (!running || pos.turn !== botColor()) return;
        move = tryUci(uci);
      } catch (e) {
        engineStatusEl.textContent = `Движок недоступен, играю простым ботом: ${(e as Error).message}`;
      }
    }

    if (!move) move = chooseMove(pos, 'human2200', rnd);

    if (!running || !clocks || pos.turn !== botColor()) return;
    if (!move) {
      checkGameEnd();
      return;
    }

    recordMove(move, performance.now() - thinkStartedAt);
    clocks.switchTo(userColor);
    renderClocks();
    const flagged = clocks.flagged();
    if (flagged) {
      void end(flagged === userColor ? 'flag-user' : 'flag-bot');
      return;
    }
    pos.play(move);
    paint([keyOf(move.from), keyOf(move.to)]);
    persist();
    userMoveStartedAt = performance.now();
    promptEl.textContent = 'Твой ход.';
    if (checkGameEnd()) return;
    later(() => {
      if (running && pos.turn === userColor) board.playPremove();
    }, 20);
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

  /** Итог партии в терминах PGN, со стороны белых. */
  function pgnResult(outcome: Outcome): GameRecord['result'] {
    const userWon = outcome === 'mate-user' || outcome === 'flag-bot';
    const botWon = outcome === 'mate-bot' || outcome === 'flag-user';
    if (outcome === 'draw') return '1/2-1/2';
    if (userWon) return userColor === 'white' ? '1-0' : '0-1';
    if (botWon) return userColor === 'white' ? '0-1' : '1-0';
    return '*';
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

    if (game) {
      game.status = outcome === 'aborted' ? 'live' : 'finished';
      game.result = pgnResult(outcome);
      game.resultLabel = OUTCOME_LABELS[outcome];
      persist();
      await autosave.flush();
    }

    const def = currentBot();
    await session?.finish({
      outcome,
      outcomeLabel: OUTCOME_LABELS[outcome],
      opponent: def.kind,
      bot: def.id,
      botRating: def.rating,
      clockMs: timeControl(tcId).initialMs,
      timeControl: tcId,
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

  const tcSeg = segmented<string>(
    TIME_CONTROLS.map((t) => ({ value: t.id, label: t.label })),
    tcId,
    (v) => {
      if (!running) tcId = v;
    },
  );

  const botSeg = botPicker(BOTS, botId, (v) => {
    if (running) return;
    botId = v;
    updateBotHint();
  });

  const botNoteEl = el('p', { class: 'hint' }, ['']);

  /**
   * Подпись под выбором бота. Здесь же — единственное место, где человек
   * узнаёт, что Maia пока не поднялась: молча подсовывать вместо неё
   * Stockfish нечестно, вся суть выбора именно в том, кто ходит.
   */
  function updateBotHint(): void {
    const def = currentBot();
    const parts = [def.note];
    if (def.kind === 'maia' && !maiaAvailable()) {
      parts.push(
        'Сейчас недоступен: для него нужна изоляция страницы. Перезагрузи вкладку — ',
        'после обновления она включается сама. До этого сыграю движком.',
      );
    }
    botNoteEl.textContent = parts.join(' ');
  }

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

  /** Общая часть старта новой партии и доигрывания сохранённой. */
  function beginRunning(): void {
    running = true;
    paint();
    clocks?.start(pos.turn);
    startTicking();
    if (pos.turn === userColor) {
      userMoveStartedAt = performance.now();
      promptEl.textContent = 'Твой ход.';
    } else {
      scheduleBotMove();
    }
  }

  async function prepareEngines(def: BotDef): Promise<void> {
    if (def.kind === 'maia' && maiaAvailable()) {
      promptEl.textContent = 'Загружаю Maia…';
      try {
        await warmUpMaia();
        return;
      } catch (e) {
        engineStatusEl.textContent = `Maia не загрузилась: ${(e as Error).message}`;
      }
    }
    if (engineSupported()) {
      promptEl.textContent = 'Загружаю движок…';
      try {
        await sharedEngine().start();
        // «Слепой» бот (kind: 'blind') слабеет не через UCI_Elo — там сила
        // ограничена глубиной поиска (blind-bot.ts), а сам движок должен
        // оценивать честно. Elo-ограничение здесь было бы двойной, и
        // разной по природе, слабостью поверх уже заложенной.
        const elo = def.kind === 'stockfish' ? (def.elo ?? null) : def.kind === 'blind' ? null : 1400;
        await sharedEngine().setStrength(elo);
        await sharedEngine().newGame();
      } catch (e) {
        engineStatusEl.textContent = `Движок не загрузился, играю простым ботом: ${(e as Error).message}`;
      }
    }
  }

  async function beginGame(): Promise<void> {
    const token = ++startToken;
    const cancelled = () => token !== startToken;
    clearTimers();
    userMoveTimes.length = 0;
    planNextHost.innerHTML = '';
    const tc = timeControl(tcId);
    const def = currentBot();

    pos = posFromFen(INITIAL_FEN);
    clocks = new Clocks(tc.initialMs, () => performance.now(), tc.incrementMs);
    running = false;
    startBtn.disabled = true;
    resignBtn.disabled = false;
    board.cancelPremove();
    paint();
    renderClocks();
    renderLive();

    game = newGameRecord({
      profileId: ctx.profile.id,
      userColor,
      bot: { id: def.id, name: def.name, rating: def.rating, kind: def.kind },
      timeControl: tc,
    });
    persist();

    await prepareEngines(def);
    if (cancelled()) return;

    // Короткий отсчёт остаётся только там, где он спасает от мгновенного
    // флага: на секундных контролях. В партии на пять минут он лишний.
    if ((tc.initialMs ?? Infinity) <= 60_000) {
      for (const n of [3, 2, 1]) {
        promptEl.textContent = `Готовность… ${n}`;
        await wait(600);
        if (cancelled()) return;
      }
    }

    session = new Session('scramble', `${def.id}:${tc.id}`, measuredCalibration(cal, board.size));
    beginRunning();
  }

  /** Доиграть сохранённую партию: восстановить позицию, ходы и часы. */
  async function resumeGame(saved: GameRecord): Promise<void> {
    const token = ++startToken;
    const cancelled = () => token !== startToken;
    clearTimers();
    userMoveTimes.length = 0;
    planNextHost.innerHTML = '';

    game = saved;
    userColor = saved.userColor;
    botId = saved.bot.id;
    tcId = saved.timeControl.id;
    botSeg.set(botId);
    tcSeg.set(tcId);
    colorSeg.set(userColor);
    updateBotHint();

    pos = posFromFen(saved.fen);
    board.setOrientation(userColor);
    clocks = new Clocks(
      saved.timeControl.initialMs,
      () => performance.now(),
      saved.timeControl.incrementMs,
    );
    if (saved.clockLeftMs) clocks.restore(saved.clockLeftMs.white, saved.clockLeftMs.black);

    running = false;
    startBtn.disabled = true;
    resignBtn.disabled = false;
    board.cancelPremove();
    paint();
    renderClocks();
    renderLive();

    await prepareEngines(currentBot());
    if (cancelled()) return;

    promptEl.textContent = 'Партия восстановлена.';
    await wait(400);
    if (cancelled()) return;

    session = new Session(
      'scramble',
      `${saved.bot.id}:${saved.timeControl.id}`,
      measuredCalibration(cal, board.size),
    );
    beginRunning();
  }

  startBtn.addEventListener('click', () => void beginGame());

  resignBtn.addEventListener('click', () => {
    if (running) {
      void end('aborted');
      return;
    }
    startToken++;
    clearTimers();
    startBtn.disabled = false;
    resignBtn.disabled = true;
    promptEl.textContent = 'Отменено до начала партии.';
    paint();
  });

  board.setOptions({ onMove });

  // Партию бросают закрытием вкладки — дописываем последнее состояние.
  const onHide = () => {
    if (game) persist();
    void autosave.flush();
  };
  window.addEventListener('pagehide', onHide);

  root.append(
    panel('Соперник', [
      botSeg.root,
      botNoteEl,
      el('div', { class: 'row' }, [el('label', {}, ['Контроль']), tcSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Играю']), colorSeg.root]),
      engineStatusEl,
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
  updateBotHint();

  // Пришли из «Моих партий» по кнопке «Продолжить» — сразу восстанавливаем.
  const resumeId = consumeResumeGame();
  if (resumeId) {
    void getGame(resumeId).then((saved) => {
      if (saved && saved.profileId === ctx.profile.id && saved.status === 'live') {
        void resumeGame(saved);
      }
    });
  } else if (currentBot().kind === 'maia' && maiaAvailable()) {
    void warmUpMaia().catch(() => undefined);
  }

  return () => {
    startToken++;
    stopTicking();
    clearTimers();
    window.removeEventListener('pagehide', onHide);
    if (running) void end('aborted');
    if (game) persist();
    autosave.dispose();
    board.destroy();
  };
}
