/**
 * «Маршрут» — третье упражнение «Моторики»: одна фигура на пустой доске,
 * подсвечена клетка, куда её можно легально перейти, — перетащи её туда
 * максимально быстро. Модуль чистый (ни DOM, ни таймеров, ни
 * Chessground): вся геометрия и режимная арифметика здесь и проверяется
 * тестами, DOM/таймеры/запись в сессию — в motorics.ts, как и у «Сигнала»
 * (см. motorics-signal.ts).
 *
 * Легальность — не Stockfish, а геометрия хода на ПУСТОЙ доске: chessops
 * `attacks(piece, square, occupied)` с пустым occupied — это ровно набор
 * клеток, куда фигура бьёт/ходит без препятствий, то есть куда она может
 * реально перейти, если больше на доске никого нет. Так же уже сделано в
 * reaction-logic.ts для «короли не могут стоять рядом».
 */

import { attacks } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';
import type { Role } from 'chessops/types';
import type { Dests, Key } from 'chessground/types';
import { keyOf, squareOf } from '../core/chess';

export type RoutePiece = Extract<Role, 'rook' | 'bishop' | 'knight' | 'queen' | 'king'>;
export type RouteMode = 'classic' | 'relay' | 'survival';

/** Порядок = порядок кнопок в Классике и порядок смены фигур в Эстафете/Survival. */
export const ROUTE_PIECES: RoutePiece[] = ['rook', 'bishop', 'knight', 'queen', 'king'];

export const ROUTE_PIECE_SYMBOL: Record<RoutePiece, string> = {
  rook: '♜',
  bishop: '♝',
  knight: '♞',
  queen: '♛',
  king: '♔',
};

export const ROUTE_PIECE_NAME: Record<RoutePiece, string> = {
  rook: 'Ладья',
  bishop: 'Слон',
  knight: 'Конь',
  queen: 'Ферзь',
  king: 'Король',
};

const ROUTE_PIECE_LETTER: Record<RoutePiece, string> = {
  rook: 'R',
  bishop: 'B',
  knight: 'N',
  queen: 'Q',
  king: 'K',
};

export const ROUTE_MODE_LABEL: Record<RouteMode, string> = {
  classic: 'Классика',
  relay: 'Эстафета',
  survival: 'Survival',
};

/** Классика: сколько перемещений в серии. */
export const CLASSIC_REPS = 20;

/** Эстафета: жёсткий лимит по часам и сколько верных ходов на фигуру. */
export const RELAY_DURATION_MS = 60_000;
export const RELAY_PER_PIECE = 5;

/** Survival: сколько ошибок (включая просрочку) допустимо всего за серию. */
export const SURVIVAL_MAX_ERRORS = 3;
export const SURVIVAL_START_LIMIT_MS = 1400;
export const SURVIVAL_MIN_LIMIT_MS = 420;
export const SURVIVAL_STEP_MS = 45;

/**
 * Лимит на перемещение в Survival: убывает с каждой попыткой и не уходит
 * ниже пола — иначе на десятой попытке лимит стал бы отрицательным.
 */
export function survivalLimitMs(index: number): number {
  return Math.max(SURVIVAL_MIN_LIMIT_MS, SURVIVAL_START_LIMIT_MS - index * SURVIVAL_STEP_MS);
}

/** Все клетки, куда `piece` геометрически может пойти с `from` на пустой доске. */
export function legalRouteTargets(piece: RoutePiece, from: Key): Key[] {
  const set = attacks({ role: piece, color: 'white' }, squareOf(from), SquareSet.empty());
  return [...set].map(keyOf);
}

export function randomRouteSquare(rnd: () => number): Key {
  const file = Math.floor(rnd() * 8);
  const rank = Math.floor(rnd() * 8);
  return (String.fromCharCode(97 + file) + String(rank + 1)) as Key;
}

/** FEN-расстановка одной белой фигуры на пустой доске (без хвоста хода/рокировок). */
export function routeFen(piece: RoutePiece, square: Key): string {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  const ranks: string[] = [];
  for (let r = 7; r >= 0; r--) {
    if (r !== rank) {
      ranks.push('8');
      continue;
    }
    let row = '';
    if (file > 0) row += String(file);
    row += ROUTE_PIECE_LETTER[piece];
    if (7 - file > 0) row += String(7 - file);
    ranks.push(row);
  }
  return ranks.join('/');
}

/** Единственная разрешённая Chessground цель перетаскивания — сама подсвеченная клетка. */
export function routeDests(from: Key, target: Key): Dests {
  return new Map([[from, [target]]]);
}

export interface RouteStep {
  piece: RoutePiece;
  from: Key;
  target: Key;
}

/**
 * Следующий шаг того же маршрута: та же фигура, но уже с клетки, на
 * которую она только что легально перешла. У всех пяти фигур на пустой
 * доске легальная цель есть с ЛЮБОЙ клетки (у короля в углу их минимум
 * три, у коня — минимум две) — но на случай, если это когда-нибудь
 * перестанет быть так, не зависаем, а начинаем заново со случайной клетки.
 */
export function nextRouteStep(piece: RoutePiece, from: Key, rnd: () => number): RouteStep {
  const options = legalRouteTargets(piece, from);
  if (!options.length) return nextRouteStep(piece, randomRouteSquare(rnd), rnd);
  const target = options[Math.floor(rnd() * options.length)];
  return { piece, from, target };
}

/** Первый шаг серии: случайная стартовая клетка. */
export function firstRouteStep(piece: RoutePiece, rnd: () => number): RouteStep {
  return nextRouteStep(piece, randomRouteSquare(rnd), rnd);
}

/**
 * Эстафета: какая фигура сейчас и на каком счету внутри её пятёрки —
 * по общему числу верных ходов с начала серии. totalCorrect=0..4 —
 * первая фигура (♜), 5..9 — вторая (♝) и так по кругу.
 */
export function relayPieceState(totalCorrect: number): { piece: RoutePiece; countInPiece: number } {
  const cycleIndex = Math.floor(totalCorrect / RELAY_PER_PIECE) % ROUTE_PIECES.length;
  return { piece: ROUTE_PIECES[cycleIndex], countInPiece: totalCorrect % RELAY_PER_PIECE };
}

/**
 * Survival: фигура тоже меняется циклически, но не пятёрками, как в
 * Эстафете, — каждый следующий ход своя фигура. Вместе с убывающим
 * лимитом это и держит режим на грани руки, а не памяти одной фигуры.
 */
export function survivalPieceState(index: number): RoutePiece {
  return ROUTE_PIECES[index % ROUTE_PIECES.length];
}

export interface RouteAttemptInput {
  mode: RouteMode;
  piece: RoutePiece;
  from: Key;
  /** Клетка фактического drop; null — вышел лимит времени, drop не случился. */
  to: Key | null;
  /** Расстояние от `from` до ЗАДАННОЙ (не обязательно фактической) цели. */
  distance: number;
  targetShownAt: number;
  pointerDownAt: number | null;
  pointerUpAt: number | null;
  correct: boolean;
  pointerType: string;
}

/**
 * Замер одного хода «Маршрута» в виде, готовом для Session.record().
 * totalMs и misses — те же поля, что понимает сводка в data-summary.ts
 * (primaryLatency/isCorrect), поэтому «Маршрут» сразу попадает в общую
 * сводку по модулю, не требуя для этого отдельного кода.
 */
export function routeMeasurementData(a: RouteAttemptInput): Record<string, unknown> {
  return {
    mode: a.mode,
    piece: a.piece,
    from: a.from,
    to: a.to,
    distance: a.distance,
    targetShownAt: a.targetShownAt,
    pointerDownAt: a.pointerDownAt,
    pointerUpAt: a.pointerUpAt,
    totalMs: a.pointerUpAt === null ? null : a.pointerUpAt - a.targetShownAt,
    correct: a.correct,
    misses: a.correct ? 0 : 1,
    pointerType: a.pointerType,
  };
}
