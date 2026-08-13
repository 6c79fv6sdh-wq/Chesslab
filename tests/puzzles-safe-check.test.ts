import { describe, it, expect } from 'vitest';
import { SAFE_CHECK_PUZZLES } from '../src/data/puzzles-safe-check';
import { safeCheckCount, safeCheckQueue, taskFromSafeCheckPuzzle } from '../src/modules/reaction-logic';
import { moveFromUci, posFromFen, tryPosFromFen } from '../src/core/chess';
import { parseSquare } from 'chessops/util';
import type { Chess } from '../src/core/chess';
import type { Square } from 'chessops/types';

/**
 * Набор проверяется здесь заново, по определению упражнения, а не по
 * метаданным исходного файла: битая задача не должна доехать до сборки.
 * Те же проверки делает импортёр (tools/import-safe-checks.mjs) — тест
 * страхует на случай, если файл данных поправят руками.
 */

/** Можно ли взять фигуру на square, включая взятие на проходе. */
function canCapture(pos: Chess, square: Square): boolean {
  const target = pos.board.get(square);
  for (const [from, tos] of pos.allDests()) {
    if (tos.has(square)) return true;
    if (
      target?.role === 'pawn' &&
      pos.epSquare !== undefined &&
      tos.has(pos.epSquare) &&
      pos.board.get(from)?.role === 'pawn'
    ) {
      return true;
    }
  }
  return false;
}

describe('задачи «безопасный шах»', () => {
  it('набор непустой, идентификаторы уникальны', () => {
    expect(SAFE_CHECK_PUZZLES.length).toBeGreaterThanOrEqual(200);
    const ids = SAFE_CHECK_PUZZLES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('одинаковых позиций в наборе нет', () => {
    const fens = SAFE_CHECK_PUZZLES.map((p) => p.fen);
    expect(new Set(fens).size).toBe(fens.length);
  });

  it('каждая задача: валидный FEN и легальный ход решения', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      expect(tryPosFromFen(p.fen), `${p.id}: невалидный FEN ${p.fen}`).not.toBeNull();
      const pos = posFromFen(p.fen);
      expect(pos.isLegal(moveFromUci(p.uci)), `${p.id}: ход ${p.uci} нелегален`).toBe(true);
    }
  });

  it('сторона на ходу под шахом не стоит — иначе это уже защита, а не атака', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      expect(posFromFen(p.fen).isCheck(), `${p.id}: сторона на ходу уже под шахом`).toBe(false);
    }
  });

  it('решение даёт шах и это не мат', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      const pos = posFromFen(p.fen);
      const after = pos.clone();
      after.play(moveFromUci(p.uci));
      expect(after.isCheck(), `${p.id}: после ${p.san} шаха нет`).toBe(true);
      expect(after.isCheckmate(), `${p.id}: ${p.san} — это мат, а не шах`).toBe(false);
    }
  });

  /**
   * Шахует именно сходившая фигура, и она одна. При вскрытом или двойном
   * шахе условие «шахующую нельзя взять» теряет смысл: взятие одной фигуры
   * шах не снимает.
   */
  it('шах даёт только что сходившая фигура, и она единственная', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      const pos = posFromFen(p.fen);
      const move = moveFromUci(p.uci);
      const after = pos.clone();
      after.play(move);
      const checkers = after.ctx().checkers;
      expect(checkers.size(), `${p.id}: шахующих фигур ${checkers.size()}`).toBe(1);
      expect(checkers.first(), `${p.id}: шахует не та фигура, что сходила`).toBe(move.to);
    }
  });

  it('шахующую фигуру нельзя взять в ответ', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      const pos = posFromFen(p.fen);
      const move = moveFromUci(p.uci);
      const after = pos.clone();
      after.play(move);
      expect(canCapture(after, move.to), `${p.id}: фигуру на ${p.uci.slice(2, 4)} можно взять`).toBe(
        false,
      );
    }
  });

  /**
   * Ключевая проверка на однозначность: упражнение принимает ровно один
   * ответ. Будь в позиции второй столь же безопасный шах — ученику
   * засчитали бы ошибку за верное решение.
   */
  it('безопасный шах в позиции ровно один', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      const pos = posFromFen(p.fen);
      const found: string[] = [];
      for (const [from, tos] of pos.allDests()) {
        for (const to of tos) {
          const move = { from, to };
          if (!pos.isLegal(move)) continue;
          const after = pos.clone();
          after.play(move);
          if (!after.isCheck() || after.isCheckmate()) continue;
          const checkers = after.ctx().checkers;
          if (checkers.size() !== 1 || checkers.first() !== to) continue;
          if (canCapture(after, to)) continue;
          found.push(`${p.fen.split(' ')[0] ? '' : ''}${from}${to}`);
        }
      }
      expect(found.length, `${p.id}: безопасных шахов ${found.length}, а не один`).toBe(1);
    }
  });

  it('заявленная фигура совпадает с реально сходившей', () => {
    for (const p of SAFE_CHECK_PUZZLES) {
      const pos = posFromFen(p.fen);
      const role = pos.board.get(parseSquare(p.uci.slice(0, 2)) as Square)?.role;
      expect(role, `${p.id}: на ${p.uci.slice(0, 2)} нет фигуры`).toBeDefined();
      expect(role, `${p.id}: заявлена ${p.piece}, на доске ${role}`).toBe(p.piece);
    }
  });

  it('очередь на сессию перемешана и без повторов', () => {
    let s = 4242 >>> 0;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const q = safeCheckQueue(rnd, 10);
    expect(q).toHaveLength(10);
    expect(new Set(q.map((p) => p.id)).size).toBe(10);
    expect(safeCheckCount()).toBe(SAFE_CHECK_PUZZLES.length);
  });

  it('задача превращается в задание с тем же единственным решением', () => {
    for (const p of SAFE_CHECK_PUZZLES.slice(0, 30)) {
      const task = taskFromSafeCheckPuzzle(p);
      expect(task.solutions.map((sol) => sol.uci)).toEqual([p.uci]);
      expect(task.userColor).toBe(posFromFen(p.fen).turn);
      expect(task.puzzleId).toBe(p.id);
    }
  });
});
