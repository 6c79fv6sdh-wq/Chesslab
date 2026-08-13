import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, metric, metrics, panel, segmented, table } from '../core/ui';
import { Session, consumePlanNavigation, markPlanNavigation, measuredCalibration } from '../core/session';
import { fmtMs, fmtPct, fmtSec, median, p90, plural } from '../core/stats';
import { getOpeningNodes, recordOpeningNode, type OpeningNodeStat } from '../core/db';
import { REPERTOIRES, type OpeningLine, type Repertoire } from '../data/repertoire';
import { stepAfter } from './today-plan';
import {
  computeHitches,
  nodePath,
  pickLine,
  type Hitch,
} from './openings-logic';
import {
  INITIAL_FEN,
  checkedColor,
  dests,
  fenOf,
  makeSan,
  moveFromKeys,
  posFromFen,
  parseSan,
  type Chess,
} from '../core/chess';
import type { Key } from 'chessground/types';

// export: сверяется тестом с порогом полноценного завершения в today-plan.ts
export const LINES_PER_SESSION = 4;

interface NodeAttempt {
  repertoireId: string;
  lineId: string;
  path: string;
  expectedSan: string;
  playedSan: string;
  correct: boolean;
  latencyMs: number;
  ply: number;
}

export function mountOpenings(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  let repertoire: Repertoire = REPERTOIRES[0];
  const cameFromPlan = consumePlanNavigation();

  root.append(el('h1', {}, ['Дебютный автомат']));

  const boardHost = el('div', { class: 'board-host' });
  const board = new Board(boardHost, {
    orientation: repertoire.userColor,
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
  });

  const promptEl = el('div', { class: 'prompt' }, ['Выбери репертуар и нажми «Старт».']);
  const verdictEl = el('div', { class: 'prompt' }, ['']);
  const liveStats = el('div', {});
  const lineNameEl = el('div', { class: 'muted' }, ['']);
  const hitchHost = el('div', {});
  const planNextHost = el('div', { class: 'plan-next-host' });

  let session: Session | null = null;
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let hitchPaths = new Set<string>();
  let line: OpeningLine | null = null;
  let pos: Chess = posFromFen(INITIAL_FEN);
  let ply = 0;
  let linesDone = 0;
  let userTurnAt = 0;
  let acceptingUserMove = false;
  const attempts: NodeAttempt[] = [];
  const timers: number[] = [];

  function later(fn: () => void, ms: number): void {
    timers.push(window.setTimeout(fn, ms));
  }

  function clearTimers(): void {
    for (const t of timers) window.clearTimeout(t);
    timers.length = 0;
  }

  function isUserMove(index: number): boolean {
    const mover = index % 2 === 0 ? 'white' : 'black';
    return mover === repertoire.userColor;
  }

  function paint(lastMove?: Key[]): void {
    // Пока ход соперника, movableColor не задан — пользователь физически
    // не может сходить за него.
    board.setPosition({
      fen: fenOf(pos),
      orientation: repertoire.userColor,
      turnColor: pos.turn,
      movableColor: acceptingUserMove ? repertoire.userColor : undefined,
      dests: acceptingUserMove ? dests(pos) : new Map(),
      lastMove,
      check: checkedColor(pos),
    });
  }

  async function refreshHitches(): Promise<Hitch[]> {
    const nodes = await getOpeningNodes(repertoire.id);
    const hitches = computeHitches([...nodes.values()]);
    hitchPaths = new Set(hitches.map((h) => h.path));
    return hitches;
  }

  function startLine(): void {
    clearTimers();
    if (!session) return;
    if (linesDone >= LINES_PER_SESSION) {
      void finish();
      return;
    }
    line = pickLine(repertoire.lines, hitchPaths, Math.random);
    pos = posFromFen(INITIAL_FEN);
    ply = 0;
    acceptingUserMove = false;
    lineNameEl.textContent = `Линия ${linesDone + 1} из ${LINES_PER_SESSION}: ${line.name}`;
    verdictEl.textContent = '';
    verdictEl.className = 'prompt';
    paint();
    advance();
  }

  function advance(): void {
    if (!line || !session) return;
    if (ply >= line.sans.length) {
      linesDone++;
      promptEl.textContent = 'Линия пройдена.';
      acceptingUserMove = false;
      paint();
      later(startLine, 1000);
      return;
    }

    if (isUserMove(ply)) {
      acceptingUserMove = true;
      promptEl.textContent = `Твой ход. ${hitchPaths.has(nodePath(line.sans, ply)) ? 'Этот узел у тебя проседает.' : ''}`;
      paint();
      userTurnAt = performance.now();
      return;
    }

    // Ход соперника: короткая пауза, затем ход по линии.
    acceptingUserMove = false;
    promptEl.textContent = 'Ход соперника.';
    paint();
    later(() => {
      if (!line || !session) return;
      const san = line.sans[ply];
      const move = parseSan(pos, san);
      if (!move) {
        // Такого быть не должно: линии проверены автотестом.
        promptEl.textContent = `Ошибка данных: ход ${san} нелегален.`;
        return;
      }
      const from = move as { from: number; to: number };
      pos.play(move);
      ply++;
      paint([keyOfSquare(from.from), keyOfSquare(from.to)]);
      advance();
    }, 420);
  }

  function keyOfSquare(sq: number): Key {
    return (String.fromCharCode(97 + (sq & 7)) + String((sq >> 3) + 1)) as Key;
  }

  function onMove(orig: Key, dest: Key): void {
    if (!acceptingUserMove || !line || !session) return;
    const expected = line.sans[ply];
    const move = moveFromKeys(pos, orig, dest);
    if (!move) {
      paint();
      return;
    }
    const played = makeSan(pos, move);
    const latency = performance.now() - userTurnAt;
    const correct = played === expected;
    const path = nodePath(line.sans, ply);

    const attempt: NodeAttempt = {
      repertoireId: repertoire.id,
      lineId: line.id,
      path,
      expectedSan: expected,
      playedSan: played,
      correct,
      latencyMs: latency,
      ply,
    };
    attempts.push(attempt);
    void session.record({ ...attempt });

    if (!correct) {
      verdictEl.textContent = `Не по репертуару. Нужно ${expected}.`;
      verdictEl.className = 'prompt verdict-bad';
      // Возвращаем позицию: доска перерисовывается из FEN, ничего руками.
      paint();
      renderLive();
      return;
    }

    // Задержка узла копится только по верным ходам: иначе метрика мешает
    // «долго думал» и «не знал ход».
    void recordOpeningNode(repertoire.id, path, expected, latency);

    verdictEl.textContent = `${played}, ${fmtMs(latency)}.`;
    verdictEl.className = 'prompt verdict-ok';
    acceptingUserMove = false;
    pos.play(move);
    ply++;
    paint([orig, dest]);
    renderLive();
    later(advance, 220);
  }

  /** Тот же расчёт, что в motorics.ts: без старта — пусто, после финиша — заморожено. */
  function elapsedMs(): number | null {
    if (startedAt === null) return null;
    return (finishedAt ?? performance.now()) - startedAt;
  }

  /** Единый вид результатов — как в motorics.ts, reaction.ts и premove.ts. */
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
        `${n} ${plural(n, ['узел', 'узла', 'узлов'])} · ` +
          `${missCount} ${plural(missCount, ['промах', 'промаха', 'промахов'])}`,
      ]),
    );
  }

  async function renderHitches(): Promise<void> {
    const hitches = await refreshHitches();
    hitchHost.innerHTML = '';
    hitchHost.append(
      table(
        ['Позиция до хода', 'Ход', 'Медиана'],
        hitches
          .slice(0, 12)
          .map((h) => [h.path || '(начало)', h.expectedSan, fmtMs(h.medianMs)]),
      ),
    );
  }

  async function finish(): Promise<void> {
    clearTimers();
    acceptingUserMove = false;
    finishedAt = performance.now();
    const correct = attempts.filter((a) => a.correct);
    await session?.finish({
      nodes: attempts.length,
      accuracy: attempts.length ? correct.length / attempts.length : null,
      medianMs: median(correct.map((a) => a.latencyMs)),
      p90Ms: p90(correct.map((a) => a.latencyMs)),
      repertoire: repertoire.id,
      // Полных линий пройдено — по нему считается завершённость дня
      // («Сегодня»/today-plan.ts): узлов на линию не фиксировано, а линий
      // за сессию всегда LINES_PER_SESSION при полном прохождении.
      linesDone,
    });
    session = null;
    promptEl.textContent = 'Сессия закончена. Результат записан.';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    renderLive();
    await renderHitches();
    renderPlanNext();
  }

  /** Часть дневной тренировки «Сегодня» — см. пояснение в motorics.ts. */
  function renderPlanNext(): void {
    planNextHost.innerHTML = '';
    if (!cameFromPlan) return;
    const next = stepAfter('openings', new Date());
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

  const repSeg = segmented<string>(
    REPERTOIRES.map((r) => ({ value: r.id, label: r.label })),
    repertoire.id,
    (v) => {
      const found = REPERTOIRES.find((r) => r.id === v);
      if (!found || session) return;
      repertoire = found;
      board.setOrientation(repertoire.userColor);
      pos = posFromFen(INITIAL_FEN);
      paint();
      void renderHitches();
    },
  );

  const startBtn = el('button', { class: 'btn primary', type: 'button' }, ['Старт']);
  const stopBtn = el('button', { class: 'btn', type: 'button' }, ['Прервать']);
  stopBtn.disabled = true;

  startBtn.addEventListener('click', () => {
    attempts.length = 0;
    linesDone = 0;
    startedAt = performance.now();
    finishedAt = null;
    planNextHost.innerHTML = '';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    void refreshHitches().then(() => {
      session = new Session('openings', repertoire.id, measuredCalibration(cal, board.size));
      renderLive();
      startLine();
    });
  });

  stopBtn.addEventListener('click', () => {
    if (session) void finish();
  });

  board.setOptions({ onMove });

  root.append(
    panel('Репертуар', [repSeg.root]),
    panel('Тренировка', [
      el('div', { class: 'board-area' }, [
        boardHost,
        el('div', { class: 'side' }, [
          lineNameEl,
          promptEl,
          verdictEl,
          liveStats,
          el('div', { class: 'row' }, [startBtn, stopBtn]),
          el('p', { class: 'hint' }, [
            'Пока ходит соперник, доска заблокирована. Узлы с задержкой выше полутора медиан выпадают чаще.',
          ]),
          planNextHost,
        ]),
      ]),
    ]),
    panel('Заминки этого репертуара', [hitchHost]),
  );

  pos = posFromFen(INITIAL_FEN);
  paint();
  renderLive();
  void renderHitches();

  return () => {
    clearTimers();
    if (session) void finish();
    board.destroy();
  };
}

export type { OpeningNodeStat };
