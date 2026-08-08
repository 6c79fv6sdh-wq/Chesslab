import { Chess } from 'chessops/chess';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';
import { parseSan, makeSan } from 'chessops/san';
import { chessgroundDests } from 'chessops/compat';
import { parseSquare, makeSquare, parseUci, makeUci, opposite } from 'chessops/util';
import { attacks } from 'chessops/attacks';
import type { Move, NormalMove, Square, Color, Role } from 'chessops/types';
import type { Key, Dests } from 'chessground/types';

export { INITIAL_FEN, Chess, makeSan, parseSan, makeFen, parseFen, makeSquare, parseSquare, opposite };
export type { Move, NormalMove, Square, Color, Role };

export interface Legal {
  ok: boolean;
  error?: string;
}

/** Разобрать FEN в позицию. Бросает при невалидном FEN/расстановке. */
export function posFromFen(fen: string): Chess {
  const setup = parseFen(fen).unwrap();
  return Chess.fromSetup(setup).unwrap();
}

/** Мягкий разбор: null вместо исключения. */
export function tryPosFromFen(fen: string): Chess | null {
  try {
    return posFromFen(fen);
  } catch {
    return null;
  }
}

export function fenIsValid(fen: string): boolean {
  return tryPosFromFen(fen) !== null;
}

export function dests(pos: Chess): Dests {
  return chessgroundDests(pos);
}

export function turnColor(pos: Chess): Color {
  return pos.turn;
}

/** Клетка короля стороны, стоящей под шахом, либо undefined. */
export function checkedKingSquare(pos: Chess): Key | undefined {
  if (!pos.isCheck()) return undefined;
  const king = pos.board.kingOf(pos.turn);
  return king === undefined ? undefined : (makeSquare(king) as Key);
}

/** Цвет стороны под шахом — в таком виде это ждёт Chessground. */
export function checkedColor(pos: Chess): Color | false {
  return pos.isCheck() ? pos.turn : false;
}

export function moveFromUci(uci: string): NormalMove {
  const m = parseUci(uci);
  if (!m || !('from' in m)) throw new Error(`bad uci: ${uci}`);
  return m;
}

export function uciOf(move: Move): string {
  return makeUci(move);
}

export function isLegalUci(pos: Chess, uci: string): boolean {
  const m = parseUci(uci);
  return !!m && pos.isLegal(m);
}

export function isLegalSan(pos: Chess, san: string): boolean {
  return parseSan(pos, san) !== undefined;
}

/**
 * Ход клик-клик/перетаскиванием с доски. Добавляет превращение в ферзя,
 * если ход пешкой на последнюю горизонталь.
 */
export function moveFromKeys(pos: Chess, orig: Key, dest: Key): NormalMove | undefined {
  const from = parseSquare(orig);
  const to = parseSquare(dest);
  if (from === undefined || to === undefined) return undefined;
  const piece = pos.board.get(from);
  let promotion: Role | undefined;
  if (piece?.role === 'pawn') {
    const rank = to >> 3;
    if (rank === 7 || rank === 0) promotion = 'queen';
  }
  const move: NormalMove = promotion ? { from, to, promotion } : { from, to };
  return pos.isLegal(move) ? move : undefined;
}

export function playUci(pos: Chess, uci: string): Chess {
  const next = pos.clone();
  next.play(moveFromUci(uci));
  return next;
}

export function playSan(pos: Chess, san: string): Chess {
  const move = parseSan(pos, san);
  if (!move) throw new Error(`illegal san: ${san}`);
  const next = pos.clone();
  next.play(move);
  return next;
}

export function allLegalMoves(pos: Chess): NormalMove[] {
  const out: NormalMove[] = [];
  for (const [from, tos] of pos.allDests()) {
    for (const to of tos) {
      const piece = pos.board.get(from);
      if (piece?.role === 'pawn' && (to >> 3 === 7 || to >> 3 === 0)) {
        for (const promotion of ['queen', 'knight', 'rook', 'bishop'] as Role[])
          out.push({ from, to, promotion });
      } else out.push({ from, to });
    }
  }
  return out;
}

export function isCapture(pos: Chess, move: NormalMove): boolean {
  if (pos.board.get(move.to)) return true;
  const piece = pos.board.get(move.from);
  return piece?.role === 'pawn' && (move.from & 7) !== (move.to & 7);
}

export function movedPieceRole(pos: Chess, move: NormalMove): Role | undefined {
  return pos.board.get(move.from)?.role;
}

export function capturedRole(pos: Chess, move: NormalMove): Role | undefined {
  const target = pos.board.get(move.to);
  if (target) return target.role;
  const piece = pos.board.get(move.from);
  if (piece?.role === 'pawn' && (move.from & 7) !== (move.to & 7)) return 'pawn';
  return undefined;
}

export const PIECE_VALUE: Record<Role, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 100,
};

/**
 * Может ли соперник побить фигуру, вставшую на поле `sq`, после хода `move`.
 * Считаем именно по позиции ПОСЛЕ хода — это и есть «нельзя отбить».
 */
export function squareIsAttackedAfter(after: Chess, sq: Square): boolean {
  const byColor = after.turn; // после хода очередь соперника
  for (const [from, tos] of after.allDests()) {
    const piece = after.board.get(from);
    if (piece?.color !== byColor) continue;
    if (tos.has(sq)) return true;
  }
  return false;
}

/** Атакует ли сторона `by` клетку `sq` (псевдолегально, без учёта связок). */
export function attackedBy(pos: Chess, sq: Square, by: Color): boolean {
  return pos.kingAttackers(sq, by, pos.board.occupied).nonEmpty();
}

/** Короли стоят вплотную — позиция невозможна. */
export function kingsAdjacent(pos: Chess): boolean {
  const w = pos.board.kingOf('white');
  const b = pos.board.kingOf('black');
  if (w === undefined || b === undefined) return true;
  return attacks({ role: 'king', color: 'white' }, w, pos.board.occupied).has(b);
}

/** Король стороны, которая НЕ ходит, под боем — позиция нелегальна. */
export function opponentKingInCheck(pos: Chess): boolean {
  const them = opposite(pos.turn);
  const king = pos.board.kingOf(them);
  if (king === undefined) return true;
  return attackedBy(pos, king, pos.turn);
}

/** Есть ли в списке ходов взятие короля. Такого быть не должно никогда. */
export function anyMoveCapturesKing(pos: Chess, moves: NormalMove[]): boolean {
  return moves.some((m) => pos.board.get(m.to)?.role === 'king');
}

export function fenOf(pos: Chess): string {
  return makeFen(pos.toSetup());
}

export function keyOf(sq: Square): Key {
  return makeSquare(sq) as Key;
}

export function squareOf(key: Key): Square {
  const sq = parseSquare(key);
  if (sq === undefined) throw new Error(`bad key: ${key}`);
  return sq;
}

export function fileOf(key: Key): number {
  return key.charCodeAt(0) - 97;
}

export function rankOf(key: Key): number {
  return key.charCodeAt(1) - 49;
}

export type Direction = 'горизонталь' | 'вертикаль' | 'диагональ' | 'конь' | 'прочее';

export function directionBetween(a: Key, b: Key): Direction {
  const dx = Math.abs(fileOf(a) - fileOf(b));
  const dy = Math.abs(rankOf(a) - rankOf(b));
  if (dy === 0 && dx > 0) return 'горизонталь';
  if (dx === 0 && dy > 0) return 'вертикаль';
  if (dx === dy && dx > 0) return 'диагональ';
  if ((dx === 1 && dy === 2) || (dx === 2 && dy === 1)) return 'конь';
  return 'прочее';
}

/** Расстояние в клетках (чебышёвское) — как «на сколько клеток тянуться». */
export function squareDistance(a: Key, b: Key): number {
  return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
}
