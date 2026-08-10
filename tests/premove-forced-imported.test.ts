import { describe, it, expect } from 'vitest';
import { PREMOVE_FORCED_IMPORTED } from '../src/data/premove-forced-imported';
import { PREMOVE_POSITIONS, positionsOf } from '../src/data/premove-positions';
import { isLegalUci, moveFromUci, posFromFen, tryPosFromFen } from '../src/core/chess';

describe('импортированные позиции «форсированное взятие»', () => {
  it('набор непустой, идентификаторы уникальны и не пересекаются с рукописными', () => {
    expect(PREMOVE_FORCED_IMPORTED.length).toBeGreaterThanOrEqual(100);
    const ids = PREMOVE_FORCED_IMPORTED.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const handwrittenIds = new Set(PREMOVE_POSITIONS.map((p) => p.id));
    for (const id of ids) expect(handwrittenIds.has(id), id).toBe(false);
  });

  it('все записи помечены режимом forced-capture и требуют premove', () => {
    for (const p of PREMOVE_FORCED_IMPORTED) {
      expect(p.mode, p.id).toBe('forced-capture');
      expect(p.shouldPremove, p.id).toBe(true);
    }
  });

  for (const p of PREMOVE_FORCED_IMPORTED) {
    describe(p.id, () => {
      it('FEN валиден', () => {
        expect(tryPosFromFen(p.fen), p.fen).not.toBeNull();
      });

      it('ходит соперник пользователя', () => {
        const pos = posFromFen(p.fen);
        expect(pos.turn).not.toBe(p.userColor);
      });

      it('ожидаемый ход соперника легален и это взятие', () => {
        const pos = posFromFen(p.fen);
        expect(isLegalUci(pos, p.expectedUci), `${p.expectedSan} (${p.expectedUci})`).toBe(true);
        const move = moveFromUci(p.expectedUci);
        expect(pos.board.get(move.to), `${p.id}: ${p.expectedSan} не взятие`).toBeDefined();
      });

      it('ответ пользователя легален после ожидаемого хода и бьёт на то же поле', () => {
        expect(p.answerUci, p.id).toBeDefined();
        const pos = posFromFen(p.fen);
        pos.play(moveFromUci(p.expectedUci));
        expect(isLegalUci(pos, p.answerUci!), `${p.answerSan} (${p.answerUci})`).toBe(true);
        expect(pos.turn).toBe(p.userColor);
        expect(p.answerUci!.slice(2, 4), p.id).toBe(p.expectedUci.slice(2, 4));
      });
    });
  }

  it('позиции подмешиваются в общий пул режима «Форсированное взятие»', () => {
    const pool = positionsOf('forced-capture');
    expect(pool.length).toBe(
      PREMOVE_POSITIONS.filter((p) => p.mode === 'forced-capture').length +
        PREMOVE_FORCED_IMPORTED.length,
    );
    for (const p of PREMOVE_FORCED_IMPORTED) {
      expect(pool.some((x) => x.id === p.id), p.id).toBe(true);
    }
  });

  it('другие режимы импортированный набор не задевает', () => {
    const before = PREMOVE_POSITIONS.filter((p) => p.mode === 'safe-unsafe').length;
    expect(positionsOf('safe-unsafe').length).toBe(before);
    const beforeCancel = PREMOVE_POSITIONS.filter((p) => p.mode === 'cancel').length;
    expect(positionsOf('cancel').length).toBe(beforeCancel);
  });
});
