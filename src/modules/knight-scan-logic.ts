/**
 * «Скан конём» — упражнение «Тактики» на сложный зрительный поиск: четыре
 * мини-доски, на каждой конь и препятствия из своих фигур, и только на
 * одной кратчайший путь коня до зелёной цели занимает ровно N ходов.
 * Модуль чистый (ни DOM, ни таймеров) — та же дисциплина, что у
 * motorics-route.ts: вся геометрия и генерация здесь и проверяется
 * тестами, DOM/таймеры/запись в сессию — в reaction.ts.
 *
 * Клетки — числа 0..63 в нумерации chessops (файл + ранг*8, a1=0), чтобы
 * без лишних преобразований совпадать с keyOf/squareOf из core/chess.ts
 * на границе с рендером. Внутри модуля вся арифметика — только числа:
 * BFS по 64 узлам не нуждается ни в FEN, ни в шахматных правилах, кроме
 * геометрии хода коня.
 */

import type { Key } from 'chessground/types';
import { keyOf, squareOf } from '../core/chess';
import { ROUTE_PIECE_ICON } from './motorics-route';

export type KnightScanLevel = 2 | 3 | 4;

/** Тот же белый конь cburnett, что и на настоящей доске (см. ROUTE_PIECE_ICON). */
export const KNIGHT_SCAN_KNIGHT_ICON = ROUTE_PIECE_ICON.knight;

/**
 * Пешка — фигура-препятствие: силуэт заведомо не спутать с конём, а
 * набор тот же cburnett, что и везде в приложении (см. пояснение у
 * ROUTE_PIECE_ICON в motorics-route.ts про то, почему не юникод-глиф).
 */
export const KNIGHT_SCAN_OBSTACLE_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PHBhdGggZD0iTTIyLjUgOWMtMi4yMSAwLTQgMS43OS00IDQgMCAuODkuMjkgMS43MS43OCAyLjM4QzE3LjMzIDE2LjUgMTYgMTguNTkgMTYgMjFjMCAyLjAzLjk0IDMuODQgMi40MSA1LjAzLTMgMS4wNi03LjQxIDUuNTUtNy40MSAxMy40N2gyM2MwLTcuOTItNC40MS0xMi40MS03LjQxLTEzLjQ3IDEuNDctMS4xOSAyLjQxLTMgMi40MS01LjAzIDAtMi40MS0xLjMzLTQuNS0zLjI4LTUuNjIuNDktLjY3Ljc4LTEuNDkuNzgtMi4zOCAwLTIuMjEtMS43OS00LTQtNHoiIGZpbGw9IiNmZmYiIHN0cm9rZT0iIzAwMCIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==";

const KNIGHT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

const EMPTY_BLOCKED: ReadonlySet<number> = new Set();

function fileOfSq(sq: number): number {
  return sq % 8;
}

function rankOfSq(sq: number): number {
  return Math.floor(sq / 8);
}

function knightNeighbors(sq: number): number[] {
  const f = fileOfSq(sq);
  const r = rankOfSq(sq);
  const out: number[] = [];
  for (const [df, dr] of KNIGHT_STEPS) {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(nr * 8 + nf);
  }
  return out;
}

export function squareToKey(sq: number): Key {
  return keyOf(sq);
}

export function keyToSquare(key: Key): number {
  return squareOf(key);
}

/**
 * Кратчайший путь коня от `start` до `target` через BFS, где клетки из
 * `blocked` вынуты из графа как узлы. Конь перепрыгивает через фигуры —
 * ход всегда прямой прыжок, промежуточных клеток на пути нет, — поэтому
 * препятствие блокирует только ПРИЗЕМЛЕНИЕ: занятая клетка просто не
 * годится ни промежуточной точкой, ни целью. `target` по контракту
 * генератора никогда не входит в `blocked`.
 *
 * Возвращает полный путь (клетки start..target включительно) или null,
 * если target недостижим.
 */
export function knightShortestPath(
  start: number,
  target: number,
  blocked: ReadonlySet<number> = EMPTY_BLOCKED,
): number[] | null {
  if (start === target) return [start];
  const prev = new Map<number, number>();
  const visited = new Set<number>([start]);
  const queue: number[] = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const nb of knightNeighbors(cur)) {
      if (visited.has(nb) || blocked.has(nb)) continue;
      visited.add(nb);
      prev.set(nb, cur);
      if (nb === target) {
        const path = [nb];
        let c = nb;
        while (c !== start) {
          c = prev.get(c) as number;
          path.push(c);
        }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

export interface KnightBoard {
  knight: number;
  target: number;
  /** Отсортированы по возрастанию — так же собирается сигнатура для дедупа. */
  obstacles: number[];
  /** Кратчайший путь при текущих obstacles, null — если target недостижим. */
  path: number[] | null;
  /** path.length - 1, либо null вместе с path. */
  distance: number | null;
}

function boardOf(knight: number, target: number, obstacles: readonly number[]): KnightBoard {
  const sorted = [...obstacles].sort((a, b) => a - b);
  const path = knightShortestPath(knight, target, new Set(sorted));
  return { knight, target, obstacles: sorted, path, distance: path ? path.length - 1 : null };
}

/** Сигнатура доски для дедупа внутри сессии — конь, цель и препятствия целиком. */
export function boardSignature(b: KnightBoard): string {
  return `${b.knight}|${b.target}|${b.obstacles.join(',')}`;
}

function randomSquare(rnd: () => number): number {
  return Math.floor(rnd() * 64);
}

/** Свободная клетка вне множества excluded. Доска маленькая (64), rejection sampling дёшев. */
function randomFreeSquare(rnd: () => number, excluded: ReadonlySet<number>): number | null {
  for (let i = 0; i < 500; i++) {
    const sq = randomSquare(rnd);
    if (!excluded.has(sq)) return sq;
  }
  return null;
}

/** Пара конь+цель со СВОБОДНЫМ (без препятствий) расстоянием ровно level. */
function findPairWithFreeDistance(
  rnd: () => number,
  level: KnightScanLevel,
  maxAttempts = 4000,
): { knight: number; target: number } | null {
  for (let i = 0; i < maxAttempts; i++) {
    const knight = randomSquare(rnd);
    const target = randomSquare(rnd);
    if (target === knight) continue;
    const path = knightShortestPath(knight, target);
    if (path && path.length - 1 === level) return { knight, target };
  }
  return null;
}

/**
 * Расставить `count` препятствий так, чтобы расстояние осталось РОВНО
 * level. Добавление клеток-дыр в граф может только увеличить кратчайший
 * путь или сделать цель недостижимой (никогда не уменьшить) — поэтому
 * тут просто перебираем расстановки, пока какая-то не сохранит длину.
 * Не нашли за отведённые попытки — возвращаем меньше препятствий (вплоть
 * до нуля): пустая расстановка расстояние не меняет по определению.
 */
function placeObstaclesKeepingDistance(
  rnd: () => number,
  knight: number,
  target: number,
  count: number,
  level: KnightScanLevel,
  maxAttempts = 300,
): number[] {
  const forced = new Set([knight, target]);
  for (let i = 0; i < maxAttempts; i++) {
    const obstacles = new Set<number>();
    let ok = true;
    while (obstacles.size < count) {
      const sq = randomFreeSquare(rnd, new Set([...forced, ...obstacles]));
      if (sq === null) {
        ok = false;
        break;
      }
      obstacles.add(sq);
    }
    if (!ok) continue;
    const path = knightShortestPath(knight, target, obstacles);
    if (path && path.length - 1 === level) return [...obstacles];
  }
  return count > 0 ? placeObstaclesKeepingDistance(rnd, knight, target, count - 1, level, maxAttempts) : [];
}

/**
 * Похожий ложный вариант: та же доска (конь, цель, все препятствия
 * верной), плюс ещё несколько препятствий сверху. По той же монотонности
 * (добавление клеток-дыр не укорачивает путь) новое расстояние гарантированно
 * ≥ level — остаётся только дождаться, пока оно станет СТРОГО больше или
 * путь пропадёт. Каждая лишняя фигура делает доску визуально ближе к
 * оригиналу — то самое «сходство ложных досок», которым по заданию
 * регулируется сложность.
 */
/**
 * Не больше трёх лишних фигур сверх верной доски: похожий вариант должен
 * читаться как «почти та же доска», а не заново обрастать препятствиями
 * до непроходимой тесноты. Не получилось уложиться в этот бюджет —
 * generateDecoy сам откатится на независимый случайный вариант.
 */
function similarDecoy(rnd: () => number, correct: KnightBoard, level: KnightScanLevel, maxExtra = 3): KnightBoard | null {
  const forced = new Set<number>([correct.knight, correct.target, ...correct.obstacles]);
  const obstacles = new Set<number>(correct.obstacles);
  for (let extra = 0; extra < maxExtra; extra++) {
    const sq = randomFreeSquare(rnd, forced);
    if (sq === null) return null;
    obstacles.add(sq);
    forced.add(sq);
    const board = boardOf(correct.knight, correct.target, [...obstacles]);
    if (board.distance === null || board.distance > level) return board;
  }
  return null;
}

/** Независимый ложный вариант: своя случайная доска, расстояние не короче level и не равное ему. */
function randomDecoy(
  rnd: () => number,
  level: KnightScanLevel,
  obstacleCount: number,
  maxAttempts = 400,
): KnightBoard | null {
  for (let i = 0; i < maxAttempts; i++) {
    const knight = randomSquare(rnd);
    const target = randomSquare(rnd);
    if (target === knight) continue;
    const forced = new Set([knight, target]);
    const obstacles = new Set<number>();
    let ok = true;
    while (obstacles.size < obstacleCount) {
      const sq = randomFreeSquare(rnd, new Set([...forced, ...obstacles]));
      if (sq === null) {
        ok = false;
        break;
      }
      obstacles.add(sq);
    }
    if (!ok) continue;
    const board = boardOf(knight, target, [...obstacles]);
    if (board.distance === null || board.distance > level) return board;
  }
  return null;
}

interface LevelDifficulty {
  obstacleCount: number;
  /** Шанс, что очередной ложный вариант будет «похожим» (см. similarDecoy), а не независимым случайным. */
  similarChance: number;
}

/**
 * Чем выше N, тем больше препятствий и тем чаще ложные доски — почти та
 * же доска с одной лишней фигурой, а не что-то очевидно другое. Числа
 * подобраны на глаз (см. распределение сложности сессии ниже), но сам
 * принцип — обе оси сложности растут вместе с N — часть задания.
 */
export const KNIGHT_SCAN_DIFFICULTY: Record<KnightScanLevel, LevelDifficulty> = {
  2: { obstacleCount: 2, similarChance: 0.25 },
  3: { obstacleCount: 3, similarChance: 0.55 },
  4: { obstacleCount: 4, similarChance: 0.85 },
};

function generateDecoy(
  rnd: () => number,
  correct: KnightBoard,
  level: KnightScanLevel,
  obstacleCount: number,
  used: ReadonlySet<string>,
): KnightBoard {
  const diff = KNIGHT_SCAN_DIFFICULTY[level];
  for (let i = 0; i < 60; i++) {
    const wantSimilar = rnd() < diff.similarChance;
    const board = wantSimilar
      ? similarDecoy(rnd, correct, level)
      : randomDecoy(rnd, level, obstacleCount);
    if (!board) continue;
    if (used.has(boardSignature(board))) continue;
    return board;
  }
  // Крайний случай (не должен встречаться на доске 8x8 при 2-4
  // препятствиях): пробуем ещё раз без похожести, уже без учёта дедупа —
  // лучше редкий повтор внутри одной сессии, чем зависшая генерация.
  for (let i = 0; i < 60; i++) {
    const board = randomDecoy(rnd, level, obstacleCount);
    if (board) return board;
  }
  throw new Error('knight-scan: не удалось собрать ложный вариант');
}

export interface KnightScanRound {
  level: KnightScanLevel;
  correctIndex: number;
  boards: KnightBoard[];
  obstacleCount: number;
}

/**
 * Ровно одна доска из четырёх обязана иметь расстояние level — это и
 * есть условие задания. Проверка вызывается сразу после сборки раунда
 * (см. generateKnightScanRound) и бросает исключение при нарушении: по
 * заданию это должно проверяться автоматически до показа, а не
 * надеяться, что генератор всегда прав.
 */
function assertExactlyOneCorrect(round: KnightScanRound): void {
  const matches = round.boards.reduce((n, b) => (b.distance === round.level ? n + 1 : n), 0);
  if (matches !== 1) {
    throw new Error(`knight-scan: должна быть ровно одна верная доска, найдено ${matches}`);
  }
  if (round.boards[round.correctIndex].distance !== round.level) {
    throw new Error('knight-scan: correctIndex указывает не на верную доску');
  }
}

export function generateKnightScanRound(
  rnd: () => number,
  level: KnightScanLevel,
  used: Set<string>,
): KnightScanRound {
  const diff = KNIGHT_SCAN_DIFFICULTY[level];
  let correct: KnightBoard | null = null;
  for (let i = 0; i < 300 && !correct; i++) {
    const pair = findPairWithFreeDistance(rnd, level);
    if (!pair) continue;
    const obstacles = placeObstaclesKeepingDistance(rnd, pair.knight, pair.target, diff.obstacleCount, level);
    const board = boardOf(pair.knight, pair.target, obstacles);
    if (board.distance !== level) continue;
    if (used.has(boardSignature(board))) continue;
    correct = board;
  }
  if (!correct) throw new Error('knight-scan: не удалось собрать верную доску');
  used.add(boardSignature(correct));

  const decoys: KnightBoard[] = [];
  for (let i = 0; i < 3; i++) {
    const decoy = generateDecoy(rnd, correct, level, diff.obstacleCount, used);
    used.add(boardSignature(decoy));
    decoys.push(decoy);
  }

  const correctIndex = Math.floor(rnd() * 4);
  const boards: KnightBoard[] = [];
  let di = 0;
  for (let slot = 0; slot < 4; slot++) {
    boards.push(slot === correctIndex ? correct : decoys[di++]);
  }

  const round: KnightScanRound = { level, correctIndex, boards, obstacleCount: diff.obstacleCount };
  assertExactlyOneCorrect(round);
  return round;
}

/** 3 разминочных (не идут в зачёт) + 20 зачётных. */
export const KNIGHT_SCAN_WARMUP = 3;
export const KNIGHT_SCAN_SCORED = 20;

/** Фиксированное распределение сложности зачётных заданий — часть задания. */
export const KNIGHT_SCAN_LEVEL_COUNTS: Record<KnightScanLevel, number> = { 2: 6, 3: 10, 4: 4 };

export interface KnightScanSession {
  seed: number;
  /** [0, KNIGHT_SCAN_WARMUP) — разминка, дальше — зачётные, порядок сложности перемешан. */
  rounds: KnightScanRound[];
}

/**
 * Все задания сессии собираются и проверяются ЗАРАНЕЕ, одним вызовом —
 * ровно то, что требуется, чтобы между попытками внутри сессии не было
 * задержки на генерацию.
 */
export function generateKnightScanSession(rnd: () => number): KnightScanSession {
  const seed = Math.floor(rnd() * 1_000_000_000);
  const used = new Set<string>();
  const rounds: KnightScanRound[] = [];

  for (let i = 0; i < KNIGHT_SCAN_WARMUP; i++) {
    rounds.push(generateKnightScanRound(rnd, 2, used));
  }

  const levels: KnightScanLevel[] = [];
  for (const levelStr of Object.keys(KNIGHT_SCAN_LEVEL_COUNTS)) {
    const level = Number(levelStr) as KnightScanLevel;
    const count = KNIGHT_SCAN_LEVEL_COUNTS[level];
    for (let i = 0; i < count; i++) levels.push(level);
  }
  for (let i = levels.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [levels[i], levels[j]] = [levels[j], levels[i]];
  }
  for (const level of levels) rounds.push(generateKnightScanRound(rnd, level, used));

  return { seed, rounds };
}

export interface KnightScanAttemptInput {
  round: KnightScanRound;
  chosenIndex: number;
  latencyMs: number;
  pointerType: string;
  boardSize: number;
  seed: number;
}

/**
 * Замер одной попытки в виде, готовом для Session.record(). correct и
 * latencyMs — те же поля, что понимает сводка в data-summary.ts
 * (primaryLatency/isCorrect для модуля 'reaction'), поэтому «Скан конём»
 * сразу попадает в общую сводку по «Тактике» без отдельного кода там.
 */
export function knightScanMeasurementData(a: KnightScanAttemptInput): Record<string, unknown> {
  const correct = a.chosenIndex === a.round.correctIndex;
  const correctBoard = a.round.boards[a.round.correctIndex];
  return {
    level: a.round.level,
    difficulty: a.round.level,
    correctIndex: a.round.correctIndex,
    chosenIndex: a.chosenIndex,
    correct,
    latencyMs: a.latencyMs,
    obstacleCount: a.round.obstacleCount,
    boards: a.round.boards.map((b) => ({
      knight: squareToKey(b.knight),
      target: squareToKey(b.target),
      obstacles: b.obstacles.map(squareToKey),
      distance: b.distance,
    })),
    path: correctBoard.path ? correctBoard.path.map(squareToKey) : null,
    pointerType: a.pointerType,
    boardSize: a.boardSize,
    seed: a.seed,
  };
}
