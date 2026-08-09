import { describe, it, expect } from 'vitest';
import { HANGING_PUZZLES, puzzleUrl } from '../src/data/puzzles-hanging';
import { findFreeCaptures } from '../src/modules/reaction-logic';
import {
  PIECE_VALUE,
  isLegalUci,
  moveFromUci,
  posFromFen,
  tryPosFromFen,
} from '../src/core/chess';

describe('задачи «висящая фигура»', () => {
  it('набор непустой, идентификаторы уникальны', () => {
    expect(HANGING_PUZZLES.length).toBeGreaterThanOrEqual(100);
    const ids = HANGING_PUZZLES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ссылка на задачу собирается корректно', () => {
    expect(puzzleUrl(HANGING_PUZZLES[0])).toBe(
      `https://lichess.org/training/${HANGING_PUZZLES[0].id}`,
    );
  });

  it('каждая задача: валидный FEN, ход белых, легальное взятие', () => {
    for (const p of HANGING_PUZZLES) {
      expect(tryPosFromFen(p.fen), `${p.id}: невалидный FEN ${p.fen}`).not.toBeNull();
      const pos = posFromFen(p.fen);

      // Все задачи набора — за белых.
      expect(pos.turn, `${p.id}: ход должен быть за белых`).toBe('white');

      expect(isLegalUci(pos, p.uci), `${p.id}: ход ${p.san} (${p.uci}) нелегален`).toBe(true);

      const move = moveFromUci(p.uci);
      const target = pos.board.get(move.to);
      expect(target, `${p.id}: ход ${p.san} не является взятием`).toBeDefined();
      expect(target!.color, `${p.id}: берём свою же фигуру`).toBe('black');
      expect(target!.role, `${p.id}: тип взятой фигуры не совпадает`).toBe(p.victim);
    }
  });

  it('берём фигуру не ниже коня: пешечные взятия сюда не попали', () => {
    for (const p of HANGING_PUZZLES) {
      expect(PIECE_VALUE[p.victim], `${p.id}: взята ${p.victim}`).toBeGreaterThanOrEqual(
        PIECE_VALUE.knight,
      );
    }
  });

  it('взятую фигуру действительно нельзя отыграть', () => {
    for (const p of HANGING_PUZZLES.filter((x) => x.free)) {
      const pos = posFromFen(p.fen);
      const after = pos.clone();
      after.play(moveFromUci(p.uci));
      const move = moveFromUci(p.uci);
      const canRecapture = [...after.allDests()].some(([from, tos]) => {
        const piece = after.board.get(from);
        return piece?.color === after.turn && tos.has(move.to);
      });
      expect(canRecapture, `${p.id}: взятие на ${p.san} можно отбить`).toBe(false);
    }
  });

  it('решение задачи находится нашим детектором бесплатных взятий', () => {
    // Детектор может найти и другие бесплатные взятия в позиции —
    // важно, чтобы авторский ход был среди них.
    const misses: string[] = [];
    for (const p of HANGING_PUZZLES.filter((x) => x.free)) {
      const pos = posFromFen(p.fen);
      const found = findFreeCaptures(pos).map((s) => s.uci);
      if (!found.includes(p.uci.slice(0, 4))) misses.push(`${p.id} (${p.san})`);
    }
    expect(misses, `детектор не увидел решение в задачах: ${misses.join(', ')}`).toEqual([]);
  });

  it('у каждой задачи проставлена тема hangingPiece', () => {
    for (const p of HANGING_PUZZLES) {
      expect(p.themes, `${p.id}: темы пустые`).not.toHaveLength(0);
      expect(p.themes.includes('hangingPiece'), `${p.id}: нет темы hangingPiece`).toBe(true);
    }
  });
});
