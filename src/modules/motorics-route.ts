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

/**
 * Те же SVG-фигуры, что и на самой доске (набор cburnett из Chessground,
 * см. board/board.ts) — не текстовые ♜♝♞♛♔. Юникод-глифы фигур рисует
 * системный шрифт, и на части устройств (особенно iOS) это тонкие
 * нечёткие закорючки, а не фигура: рядом с настоящей доской это сразу
 * читается как дешёвая заглушка. Тут — те же самые base64-SVG, что
 * chessground.cburnett.css кладёт для белых фигур на саму доску: и на
 * кнопке-выборе, и на настоящей клетке — один и тот же рисунок.
 */
export const ROUTE_PIECE_ICON: Record<RoutePiece, string> = {
  rook:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0iI2ZmZiIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik05IDM5aDI3di0zSDl2M3ptMy0zdi00aDIxdjRIMTJ6bS0xLTIyVjloNHYyaDVWOWg1djJoNVY5aDR2NSIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiLz48cGF0aCBkPSJNMzQgMTRsLTMgM0gxNGwtMy0zIi8+PHBhdGggZD0iTTMxIDE3djEyLjVIMTRWMTciIHN0cm9rZS1saW5lY2FwPSJidXR0IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIi8+PHBhdGggZD0iTTMxIDI5LjVsMS41IDIuNWgtMjBsMS41LTIuNSIvPjxwYXRoIGQ9Ik0xMSAxNGgyMyIgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVqb2luPSJtaXRlciIvPjwvZz48L3N2Zz4=",
  bishop:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxnIGZpbGw9IiNmZmYiIHN0cm9rZS1saW5lY2FwPSJidXR0Ij48cGF0aCBkPSJNOSAzNmMzLjM5LS45NyAxMC4xMS40MyAxMy41LTIgMy4zOSAyLjQzIDEwLjExIDEuMDMgMTMuNSAyIDAgMCAxLjY1LjU0IDMgMi0uNjguOTctMS42NS45OS0zIC41LTMuMzktLjk3LTEwLjExLjQ2LTEzLjUtMS0zLjM5IDEuNDYtMTAuMTEuMDMtMTMuNSAxLTEuMzU0LjQ5LTIuMzIzLjQ3LTMtLjUgMS4zNTQtMS45NCAzLTIgMy0yeiIvPjxwYXRoIGQ9Ik0xNSAzMmMyLjUgMi41IDEyLjUgMi41IDE1IDAgLjUtMS41IDAtMiAwLTIgMC0yLjUtMi41LTQtMi41LTQgNS41LTEuNSA2LTExLjUtNS0xNS41LTExIDQtMTAuNSAxNC01IDE1LjUgMCAwLTIuNSAxLjUtMi41IDQgMCAwLS41LjUgMCAyeiIvPjxwYXRoIGQ9Ik0yNSA4YTIuNSAyLjUgMCAxIDEtNSAwIDIuNSAyLjUgMCAxIDEgNSAweiIvPjwvZz48cGF0aCBkPSJNMTcuNSAyNmgxME0xNSAzMGgxNW0tNy41LTE0LjV2NU0yMCAxOGg1IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIi8+PC9nPjwvc3ZnPg==",
  knight:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMiAxMGMxMC41IDEgMTYuNSA4IDE2IDI5SDE1YzAtOSAxMC02LjUgOC0yMSIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0yNCAxOGMuMzggMi45MS01LjU1IDcuMzctOCA5LTMgMi0yLjgyIDQuMzQtNSA0LTEuMDQyLS45NCAxLjQxLTMuMDQgMC0zLTEgMCAuMTkgMS4yMy0xIDItMSAwLTQuMDAzIDEtNC00IDAtMiA2LTEyIDYtMTJzMS44OS0xLjkgMi0zLjVjLS43My0uOTk0LS41LTItLjUtMyAxLTEgMyAyLjUgMyAyLjVoMnMuNzgtMS45OTIgMi41LTNjMSAwIDEgMyAxIDMiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNOS41IDI1LjVhLjUuNSAwIDEgMS0xIDAgLjUuNSAwIDEgMSAxIDB6bTUuNDMzLTkuNzVhLjUgMS41IDMwIDEgMS0uODY2LS41LjUgMS41IDMwIDEgMSAuODY2LjV6IiBmaWxsPSIjMDAwIi8+PC9nPjwvc3ZnPg==",
  queen:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0iI2ZmZiIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik04IDEyYTIgMiAwIDEgMS00IDAgMiAyIDAgMSAxIDQgMHptMTYuNS00LjVhMiAyIDAgMSAxLTQgMCAyIDIgMCAxIDEgNCAwek00MSAxMmEyIDIgMCAxIDEtNCAwIDIgMiAwIDEgMSA0IDB6TTE2IDguNWEyIDIgMCAxIDEtNCAwIDIgMiAwIDEgMSA0IDB6TTMzIDlhMiAyIDAgMSAxLTQgMCAyIDIgMCAxIDEgNCAweiIvPjxwYXRoIGQ9Ik05IDI2YzguNS0xLjUgMjEtMS41IDI3IDBsMi0xMi03IDExVjExbC01LjUgMTMuNS0zLTE1LTMgMTUtNS41LTE0VjI1TDcgMTRsMiAxMnoiIHN0cm9rZS1saW5lY2FwPSJidXR0Ii8+PHBhdGggZD0iTTkgMjZjMCAyIDEuNSAyIDIuNSA0IDEgMS41IDEgMSAuNSAzLjUtMS41IDEtMS41IDIuNS0xLjUgMi41LTEuNSAxLjUuNSAyLjUuNSAyLjUgNi41IDEgMTYuNSAxIDIzIDAgMCAwIDEuNS0xIDAtMi41IDAgMCAuNS0xLjUtMS0yLjUtLjUtMi41LS41LTIgLjUtMy41IDEtMiAyLjUtMiAyLjUtNC04LjUtMS41LTE4LjUtMS41LTI3IDB6IiBzdHJva2UtbGluZWNhcD0iYnV0dCIvPjxwYXRoIGQ9Ik0xMS41IDMwYzMuNS0xIDE4LjUtMSAyMiAwTTEyIDMzLjVjNi0xIDE1LTEgMjEgMCIgZmlsbD0ibm9uZSIvPjwvZz48L3N2Zz4=",
  king:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0NSIgaGVpZ2h0PSI0NSI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMi41IDExLjYzVjZNMjAgOGg1IiBzdHJva2UtbGluZWpvaW49Im1pdGVyIi8+PHBhdGggZD0iTTIyLjUgMjVzNC41LTcuNSAzLTEwLjVjMCAwLTEtMi41LTMtMi41cy0zIDIuNS0zIDIuNWMtMS41IDMgMyAxMC41IDMgMTAuNSIgZmlsbD0iI2ZmZiIgc3Ryb2tlLWxpbmVjYXA9ImJ1dHQiIHN0cm9rZS1saW5lam9pbj0ibWl0ZXIiLz48cGF0aCBkPSJNMTEuNSAzN2M1LjUgMy41IDE1LjUgMy41IDIxIDB2LTdzOS00LjUgNi0xMC41Yy00LTYuNS0xMy41LTMuNS0xNiA0VjI3di0zLjVjLTMuNS03LjUtMTMtMTAuNS0xNi00LTMgNiA1IDEwIDUgMTBWMzd6IiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTExLjUgMzBjNS41LTMgMTUuNS0zIDIxIDBtLTIxIDMuNWM1LjUtMyAxNS41LTMgMjEgMG0tMjEgMy41YzUuNS0zIDE1LjUtMyAyMSAwIi8+PC9nPjwvc3ZnPg==",
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
