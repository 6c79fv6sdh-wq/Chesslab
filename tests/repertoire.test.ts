import { describe, it, expect } from 'vitest';
import { REPERTOIRES } from '../src/data/repertoire';
import { INITIAL_FEN, makeSan, parseSan, posFromFen } from '../src/core/chess';

describe('репертуары', () => {
  it('ровно три репертуара с ожидаемыми id', () => {
    expect(REPERTOIRES.map((r) => r.id)).toEqual(['white-e4', 'black-vs-e4', 'black-vs-d4']);
  });

  it('id линий уникальны внутри репертуара', () => {
    for (const rep of REPERTOIRES) {
      const ids = rep.lines.map((l) => l.id);
      expect(new Set(ids).size, rep.id).toBe(ids.length);
    }
  });

  for (const rep of REPERTOIRES) {
    describe(rep.label, () => {
      for (const line of rep.lines) {
        it(`${line.name}: каждый SAN легален от начальной позиции`, () => {
          const pos = posFromFen(INITIAL_FEN);
          line.sans.forEach((san, i) => {
            const move = parseSan(pos, san);
            expect(
              move,
              `${rep.id}/${line.id}: ход ${i + 1} «${san}» нелегален после ${line.sans
                .slice(0, i)
                .join(' ')}`,
            ).toBeDefined();
            // SAN должен совпасть с каноничной записью движка: так ловятся
            // и лишние, и пропущенные суффиксы шаха.
            expect(makeSan(pos, move!), `${rep.id}/${line.id}: ход ${i + 1}`).toBe(san);
            pos.play(move!);
          });
          expect(line.sans.length).toBeGreaterThan(0);
        });

        it(`${line.name}: линия начинается ходом белых и чередуется`, () => {
          const pos = posFromFen(INITIAL_FEN);
          line.sans.forEach((san, i) => {
            expect(pos.turn, `${line.id}: ход ${i + 1}`).toBe(i % 2 === 0 ? 'white' : 'black');
            pos.play(parseSan(pos, san)!);
          });
        });
      }
    });
  }

  it('в наборе есть и рокировка, и ходы с шахом', () => {
    const all = REPERTOIRES.flatMap((r) => r.lines.flatMap((l) => l.sans));
    expect(all.some((s) => s === 'O-O')).toBe(true);
    expect(all.some((s) => s.endsWith('+'))).toBe(true);
  });

  it('пользователь отвечает на каждый ход соперника: длина линии позволяет', () => {
    for (const rep of REPERTOIRES) {
      for (const line of rep.lines) {
        // Белыми первый ход делает пользователь, чёрными — соперник.
        expect(line.sans.length, `${rep.id}/${line.id}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
