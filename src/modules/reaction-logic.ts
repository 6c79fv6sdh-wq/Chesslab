import { Chess } from 'chessops/chess';
import { Board as ChessopsBoard } from 'chessops/board';
import { SquareSet } from 'chessops/squareSet';
import { Setup } from 'chessops/setup';
import { attacks } from 'chessops/attacks';
import type { Color, Role, Square, NormalMove } from 'chessops/types';
import {
  PIECE_VALUE,
  allLegalMoves,
  capturedRole,
  fenOf,
  keyOf,
  kingsAdjacent,
  opponentKingInCheck,
  posFromFen as posFromFenStrict,
} from '../core/chess';

import { HANGING_PUZZLES, type HangingPuzzle } from '../data/puzzles-hanging';
import { MATE_PUZZLES, type MatePuzzle } from '../data/puzzles-mate';
import { SAFE_CHECK_PUZZLES, type SafeCheckPuzzle } from '../data/puzzles-safe-check';

export type Rng = () => number;

export interface GeneratedPosition {
  pos: Chess;
  fen: string;
}

const PLACEABLE: Role[] = ['queen', 'rook', 'bishop', 'knight', 'pawn'];

function randomInt(rnd: Rng, n: number): number {
  return Math.floor(rnd() * n);
}

function pick<T>(rnd: Rng, items: T[]): T {
  return items[randomInt(rnd, items.length)];
}

/**
 * Случайная позиция под упражнения «Реакция».
 *
 * Гарантии (проверяются автотестом на 2000 прогонах):
 *  - FEN валиден и позиция принимается движком;
 *  - короли не стоят рядом;
 *  - сторона, чей ход, не под шахом;
 *  - король соперника не под боем.
 *
 * Возвращает null, если за отведённое число попыток ничего не собралось —
 * вызывающий код просто пробует ещё раз.
 */
export function generatePosition(rnd: Rng, turn?: Color, attempts = 200): GeneratedPosition | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const board = ChessopsBoard.empty();
    const used = new Set<Square>();

    const place = (sq: Square, role: Role, color: Color): void => {
      board.set(sq, { role, color });
      used.add(sq);
    };

    const freeSquare = (): Square | null => {
      for (let tries = 0; tries < 64; tries++) {
        const sq = randomInt(rnd, 64) as Square;
        if (!used.has(sq)) return sq;
      }
      return null;
    };

    const wk = randomInt(rnd, 64) as Square;
    place(wk, 'king', 'white');
    let bk: Square | null = null;
    for (let tries = 0; tries < 64; tries++) {
      const sq = randomInt(rnd, 64) as Square;
      if (used.has(sq)) continue;
      // Короли рядом стоять не могут.
      if (attacks({ role: 'king', color: 'white' }, wk, SquareSet.empty()).has(sq)) continue;
      bk = sq;
      break;
    }
    if (bk === null) continue;
    place(bk, 'king', 'black');

    const extra = 5 + randomInt(rnd, 7);
    for (let i = 0; i < extra; i++) {
      const sq = freeSquare();
      if (sq === null) break;
      const role = pick(rnd, PLACEABLE);
      const color: Color = rnd() < 0.5 ? 'white' : 'black';
      const rank = sq >> 3;
      // Пешки не стоят на крайних горизонталях.
      if (role === 'pawn' && (rank === 0 || rank === 7)) continue;
      place(sq, role, color);
    }

    const sideToMove: Color = turn ?? (rnd() < 0.5 ? 'white' : 'black');
    const setup: Setup = {
      board,
      pockets: undefined,
      turn: sideToMove,
      castlingRights: SquareSet.empty(),
      epSquare: undefined,
      remainingChecks: undefined,
      halfmoves: 0,
      fullmoves: 1,
    };

    const res = Chess.fromSetup(setup);
    if (res.isErr) continue;
    const pos = res.unwrap();

    if (kingsAdjacent(pos)) continue;
    if (opponentKingInCheck(pos)) continue;
    // Сторона на своём ходу не должна стоять под шахом.
    if (pos.isCheck()) continue;
    if (!allLegalMoves(pos).length) continue;

    return { pos, fen: fenOf(pos) };
  }
  return null;
}

/** Может ли соперник побить фигуру, стоящую на sq, в позиции after. */
function canBeRecaptured(after: Chess, sq: Square): boolean {
  for (const [from, tos] of after.allDests()) {
    const piece = after.board.get(from);
    if (piece?.color !== after.turn) continue;
    if (tos.has(sq)) return true;
  }
  return false;
}

export interface SolutionMove {
  uci: string;
  from: string;
  to: string;
}

const toSolution = (m: NormalMove): SolutionMove => ({
  uci: `${keyOf(m.from)}${keyOf(m.to)}${m.promotion ? m.promotion[0] : ''}`,
  from: keyOf(m.from),
  to: keyOf(m.to),
});

/**
 * Бесплатное взятие: берём фигуру ценностью не ниже коня, и отбить её
 * соперник не может.
 */
export function findFreeCaptures(pos: Chess): SolutionMove[] {
  const out: SolutionMove[] = [];
  const seen = new Set<string>();
  for (const move of allLegalMoves(pos)) {
    const victim = capturedRole(pos, move);
    if (!victim || victim === 'king') continue;
    if (PIECE_VALUE[victim] < PIECE_VALUE.knight) continue;
    const after = pos.clone();
    after.play(move);
    if (canBeRecaptured(after, move.to)) continue;
    const sol = toSolution(move);
    // Превращения в разные фигуры — одно и то же взятие для упражнения.
    const key = `${sol.from}${sol.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uci: key, from: sol.from, to: sol.to });
  }
  return out;
}

/** Безопасный шах: шах, при котором шахующую фигуру нельзя взять. */
export function findSafeChecks(pos: Chess): SolutionMove[] {
  const out: SolutionMove[] = [];
  const seen = new Set<string>();
  for (const move of allLegalMoves(pos)) {
    const after = pos.clone();
    after.play(move);
    if (!after.isCheck()) continue;
    if (canBeRecaptured(after, move.to)) continue;
    const sol = toSolution(move);
    const key = `${sol.from}${sol.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uci: key, from: sol.from, to: sol.to });
  }
  return out;
}

export interface ReactionTask {
  fen: string;
  pos: Chess;
  userColor: Color;
  solutions: SolutionMove[];
}

/** Позиция, в которой есть хотя бы одно бесплатное взятие. */
export function generateFreeCaptureTask(rnd: Rng, tries = 400): ReactionTask | null {
  for (let i = 0; i < tries; i++) {
    const gen = generatePosition(rnd);
    if (!gen) continue;
    const solutions = findFreeCaptures(gen.pos);
    if (!solutions.length) continue;
    return { fen: gen.fen, pos: gen.pos, userColor: gen.pos.turn, solutions };
  }
  return null;
}

/** Позиция, в которой есть хотя бы один безопасный шах. */
export function generateSafeCheckTask(rnd: Rng, tries = 400): ReactionTask | null {
  for (let i = 0; i < tries; i++) {
    const gen = generatePosition(rnd);
    if (!gen) continue;
    const solutions = findSafeChecks(gen.pos);
    if (!solutions.length) continue;
    return { fen: gen.fen, pos: gen.pos, userColor: gen.pos.turn, solutions };
  }
  return null;
}

/** О чём спрашиваем: куда фигура пришла или откуда ушла. */
export type DeltaDirection = 'to' | 'from';

export interface DeltaTask {
  fen: string;
  pos: Chess;
  /** Ход соперника, который надо заметить. */
  moveUci: string;
  from: string;
  to: string;
  /** Позиция после хода соперника. */
  afterFen: string;
  /** Пользователь смотрит с этой стороны. */
  userColor: Color;
  direction: DeltaDirection;
}

/** Клетка-ответ для задания: зависит от того, о чём спросили. */
export function deltaAnswer(task: DeltaTask): string {
  return task.direction === 'to' ? task.to : task.from;
}

/**
 * Изменилось ровно одно поле «откуда» и одно «куда»?
 *
 * Опасны рокировка (двигает сразу две фигуры) и взятие на проходе (убирает
 * пешку с третьего поля): на них вопрос «откуда переместилась?» честно
 * неоднозначен — опустело два поля, и оба ответа осмысленны.
 *
 * Сейчас generatePosition такие ходы породить не может: он собирает
 * позицию с пустыми castlingRights и без epSquare. Проверка тут на
 * будущее — стоит генератору начать выдавать позиции с рокировкой, и
 * упражнение молча начнёт спрашивать неразрешимое. Сравниваем сами доски,
 * а не перечисляем частные случаи, чтобы не проглядеть ещё какой-нибудь.
 */
function movedExactlyOneSquare(before: Chess, after: Chess, from: string, to: string): boolean {
  const vacated: string[] = [];
  const changed: string[] = [];
  for (let sq = 0 as Square; sq < 64; sq = (sq + 1) as Square) {
    const a = before.board.get(sq);
    const b = after.board.get(sq);
    const same = a && b ? a.role === b.role && a.color === b.color : a === b;
    if (same) continue;
    if (a && !b) vacated.push(keyOf(sq));
    else changed.push(keyOf(sq));
  }
  return (
    vacated.length === 1 && vacated[0] === from && changed.length === 1 && changed[0] === to
  );
}

/**
 * Позиция плюс ход соперника: пользователь указывает поле прихода или
 * ухода — что именно, задаёт `direction` (по умолчанию вопрос выбирается
 * случайно, чтобы задания шли вперемешку).
 */
export function generateDeltaTask(
  rnd: Rng,
  tries = 400,
  direction?: DeltaDirection,
): DeltaTask | null {
  for (let i = 0; i < tries; i++) {
    const gen = generatePosition(rnd);
    if (!gen) continue;
    const moves = allLegalMoves(gen.pos);
    if (!moves.length) continue;
    const move = moves[randomInt(rnd, moves.length)];
    const after = gen.pos.clone();
    after.play(move);
    const sol = toSolution(move);
    if (!movedExactlyOneSquare(gen.pos, after, sol.from, sol.to)) continue;
    return {
      fen: gen.fen,
      pos: gen.pos,
      moveUci: sol.uci,
      from: sol.from,
      to: sol.to,
      afterFen: fenOf(after),
      // Ходит соперник, значит пользователь смотрит с другой стороны.
      userColor: gen.pos.turn === 'white' ? 'black' : 'white',
      direction: direction ?? (rnd() < 0.5 ? 'to' : 'from'),
    };
  }
  return null;
}

/** Задание из реальной задачи Lichess. */
export interface PuzzleTask extends ReactionTask {
  puzzleId: string;
  san: string;
  /** Взятая фигура — только у задач «висящая фигура». */
  victim?: string;
}

function taskFromSolution(fen: string, id: string, uci: string, san: string, victim?: string): PuzzleTask {
  const pos = posFromFenStrict(fen);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  return {
    fen,
    pos,
    userColor: pos.turn,
    solutions: [{ uci: `${from}${to}`, from, to }],
    puzzleId: id,
    san,
    victim,
  };
}

/** Превращает задачу «висящая фигура» в задание упражнения. */
export function taskFromPuzzle(p: HangingPuzzle): PuzzleTask {
  return taskFromSolution(p.fen, p.id, p.uci, p.san, p.victim);
}

/** Превращает задачу «мат в один ход» в задание упражнения. */
export function taskFromMatePuzzle(p: MatePuzzle): PuzzleTask {
  return taskFromSolution(p.fen, p.id, p.uci, p.san);
}

/** Превращает задачу «безопасный шах» в задание упражнения. */
export function taskFromSafeCheckPuzzle(p: SafeCheckPuzzle): PuzzleTask {
  return taskFromSolution(p.fen, p.id, p.uci, p.san);
}

/** Перемешивает набор и берёт первые count элементов — очередь на сессию без повторов. */
function shuffledQueue<T>(pool: readonly T[], rnd: Rng, count: number): T[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

/** Очередь задач «висящая фигура» на сессию: перемешана, без повторов. */
export function puzzleQueue(rnd: Rng, count: number): HangingPuzzle[] {
  return shuffledQueue(HANGING_PUZZLES, rnd, count);
}

export function puzzleCount(): number {
  return HANGING_PUZZLES.length;
}

/** Очередь задач «мат в один ход» на сессию: перемешана, без повторов. */
export function matePuzzleQueue(rnd: Rng, count: number): MatePuzzle[] {
  return shuffledQueue(MATE_PUZZLES, rnd, count);
}

export function matePuzzleCount(): number {
  return MATE_PUZZLES.length;
}

/** Очередь задач «безопасный шах» на сессию: перемешана, без повторов. */
export function safeCheckQueue(rnd: Rng, count: number): SafeCheckPuzzle[] {
  return shuffledQueue(SAFE_CHECK_PUZZLES, rnd, count);
}

export function safeCheckCount(): number {
  return SAFE_CHECK_PUZZLES.length;
}
