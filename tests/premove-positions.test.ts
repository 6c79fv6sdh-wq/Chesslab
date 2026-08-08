import { describe, it, expect } from 'vitest';
import { PREMOVE_POSITIONS, positionsOf } from '../src/data/premove-positions';
import { opponentColorOf } from '../src/modules/premove';
import { isLegalUci, moveFromUci, posFromFen, tryPosFromFen } from '../src/core/chess';

describe('позиции premove', () => {
  it('набор непустой и все id уникальны', () => {
    expect(PREMOVE_POSITIONS.length).toBeGreaterThan(0);
    const ids = PREMOVE_POSITIONS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('все три режима наполнены', () => {
    expect(positionsOf('forced-capture').length).toBeGreaterThan(0);
    expect(positionsOf('safe-unsafe').length).toBeGreaterThan(0);
    expect(positionsOf('cancel').length).toBeGreaterThan(0);
  });

  for (const p of PREMOVE_POSITIONS) {
    describe(p.id, () => {
      it('FEN валиден', () => {
        expect(tryPosFromFen(p.fen), p.fen).not.toBeNull();
      });

      it('ходит соперник, а не пользователь', () => {
        const pos = posFromFen(p.fen);
        expect(pos.turn).toBe(opponentColorOf(p));
      });

      it('ожидаемый ход соперника легален', () => {
        const pos = posFromFen(p.fen);
        expect(isLegalUci(pos, p.expectedUci), `${p.expectedSan} (${p.expectedUci})`).toBe(true);
      });

      it('ответ пользователя легален после ожидаемого хода', () => {
        if (!p.answerUci) return;
        const pos = posFromFen(p.fen);
        pos.play(moveFromUci(p.expectedUci));
        expect(isLegalUci(pos, p.answerUci), `${p.answerSan} (${p.answerUci})`).toBe(true);
        // Ответ делает именно пользователь.
        expect(pos.turn).toBe(p.userColor);
      });

      it('альтернативные ходы соперника легальны', () => {
        const pos = posFromFen(p.fen);
        for (const uci of p.alternatives ?? []) {
          expect(isLegalUci(pos, uci), uci).toBe(true);
        }
      });

      it('неожиданный ход легален и отличается от ожидаемого', () => {
        if (!p.unexpectedUci) return;
        const pos = posFromFen(p.fen);
        expect(isLegalUci(pos, p.unexpectedUci), `${p.unexpectedSan} (${p.unexpectedUci})`).toBe(
          true,
        );
        expect(p.unexpectedUci).not.toBe(p.expectedUci);
      });
    });
  }

  it('в режиме отмены у каждой позиции есть неожиданный ход и заготовленный ответ', () => {
    for (const p of positionsOf('cancel')) {
      expect(p.unexpectedUci, p.id).toBeDefined();
      expect(p.answerUci, p.id).toBeDefined();
    }
  });

  it('в форсированных взятиях ожидаемый ход соперника действительно взятие', () => {
    for (const p of positionsOf('forced-capture')) {
      const pos = posFromFen(p.fen);
      const move = moveFromUci(p.expectedUci);
      expect(pos.board.get(move.to), `${p.id}: ${p.expectedSan}`).toBeDefined();
    }
  });

  it('в форсированных взятиях ответ пользователя — взятие на том же поле', () => {
    for (const p of positionsOf('forced-capture')) {
      expect(p.answerUci, p.id).toBeDefined();
      expect(p.answerUci!.slice(2, 4), p.id).toBe(p.expectedUci.slice(2, 4));
    }
  });

  it('позиции, где premove безопасен, действительно вынуждены: ровно один легальный ход', () => {
    for (const p of positionsOf('safe-unsafe').filter((x) => x.shouldPremove)) {
      const pos = posFromFen(p.fen);
      const count = [...pos.allDests().values()].reduce((a, s) => a + s.size(), 0);
      expect(count, `${p.id} должен быть единственным ходом соперника`).toBe(1);
    }
  });

  it('позиции, где premove не нужен, дают сопернику выбор', () => {
    for (const p of positionsOf('safe-unsafe').filter((x) => !x.shouldPremove)) {
      expect(p.alternatives?.length ?? 0, p.id).toBeGreaterThan(0);
    }
  });
});
