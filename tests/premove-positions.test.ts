import { describe, it, expect } from 'vitest';
import { positionsOf, type PremoveMode } from '../src/data/premove-positions';
import { opponentColorOf } from '../src/modules/premove';
import { isLegalUci, moveFromUci, posFromFen, tryPosFromFen } from '../src/core/chess';

/**
 * Пул Premove собирается офлайн-скриптом (tools/build-premove-pool.mjs) из
 * реальных партий и заново проверяется движком правил здесь — независимо
 * от того, что скрипт уже проверил сам. Ни одна задача без источника или
 * с нелегальным ходом до сборки не доедет (см. отчёт сборки в консоли
 * скрипта), но регрессия в самом файле src/data/premove-pool.ts всё равно
 * должна ловиться тестом, а не молча просачиваться в приложение.
 */
const MODES: PremoveMode[] = ['forced-capture', 'safe-unsafe', 'cancel'];

describe('пул Premove', () => {
  it('каждый режим непустой, id внутри модуля уникальны', () => {
    for (const mode of MODES) {
      const pool = positionsOf(mode);
      expect(pool.length, mode).toBeGreaterThan(0);
      const ids = pool.map((p) => p.id);
      expect(new Set(ids).size, mode).toBe(ids.length);
    }
  });

  it('у каждой задачи есть проверяемый источник партии', () => {
    for (const mode of MODES) {
      for (const t of positionsOf(mode)) {
        expect(t.source.white.length, t.id).toBeGreaterThan(0);
        expect(t.source.black.length, t.id).toBeGreaterThan(0);
        expect(t.source.event.length, t.id).toBeGreaterThan(0);
        expect(t.source.date.length, t.id).toBeGreaterThan(0);
        expect(t.source.ply, t.id).toBeGreaterThan(0);
        expect(t.evalMeta.engine.length, t.id).toBeGreaterThan(0);
        expect(t.evalMeta.depth, t.id).toBeGreaterThan(0);
      }
    }
  });

  for (const mode of MODES) {
    describe(mode, () => {
      for (const t of positionsOf(mode)) {
        describe(t.id, () => {
          it('FEN валиден', () => {
            expect(tryPosFromFen(t.fen), t.fen).not.toBeNull();
          });

          it('ходит соперник, а не пользователь', () => {
            const pos = posFromFen(t.fen);
            expect(pos.turn).toBe(opponentColorOf(t));
          });

          it('ожидаемый ход соперника легален', () => {
            const pos = posFromFen(t.fen);
            expect(isLegalUci(pos, t.expectedUci), `${t.expectedSan} (${t.expectedUci})`).toBe(true);
          });

          it('ответ/premove легален В ПОЗИЦИИ ПОСЛЕ ожидаемого хода', () => {
            const pos = posFromFen(t.fen);
            pos.play(moveFromUci(t.expectedUci));
            expect(isLegalUci(pos, t.answerUci), `${t.answerSan} (${t.answerUci})`).toBe(true);
            expect(pos.turn).toBe(t.userColor);
          });

          it('описание совпадает с фактическими SAN', () => {
            expect(t.comment).toContain(t.expectedSan);
            if (t.mode !== 'cancel' || t.correctAction === 'keep') {
              expect(t.comment).toContain(t.answerSan);
            }
          });

          if (t.mode === 'cancel' && t.correctAction === 'remove') {
            it('неожиданный ход легален в исходной позиции и отличается от ожидаемого', () => {
              const pos = posFromFen(t.fen);
              expect(t.unexpectedUci).toBeDefined();
              expect(isLegalUci(pos, t.unexpectedUci!), t.unexpectedSan).toBe(true);
              expect(t.unexpectedUci).not.toBe(t.expectedUci);
            });

            it('после неожиданного хода premove остаётся легальным (иначе нечего снимать)', () => {
              const pos = posFromFen(t.fen);
              pos.play(moveFromUci(t.unexpectedUci!));
              expect(isLegalUci(pos, t.answerUci)).toBe(true);
            });
          }
        });
      }
    });
  }

  it('форсированное взятие: ожидаемый ход соперника — всегда взятие', () => {
    for (const t of positionsOf('forced-capture')) {
      const pos = posFromFen(t.fen);
      const move = moveFromUci(t.expectedUci);
      expect(pos.board.get(move.to), `${t.id}: ${t.expectedSan}`).toBeDefined();
    }
  });

  it('форсированное взятие: ответ пользователя бьёт на то же поле', () => {
    for (const t of positionsOf('forced-capture')) {
      expect(t.answerUci.slice(2, 4), t.id).toBe(t.expectedUci.slice(2, 4));
    }
  });

  it('safe/unsafe: у unsafe-задач указана опасная альтернатива', () => {
    for (const t of positionsOf('safe-unsafe').filter((x) => !x.shouldPremove)) {
      expect(t.dangerousUci, t.id).toBeDefined();
      const pos = posFromFen(t.fen);
      expect(isLegalUci(pos, t.dangerousUci!), t.id).toBe(true);
    }
  });

  it('отмена: у каждой задачи задано правильное действие — оставить или снять', () => {
    for (const t of positionsOf('cancel')) {
      expect(['keep', 'remove']).toContain(t.correctAction);
    }
  });

  it('ни одна задача не дублирует другую внутри своего режима (позиция + зеркало)', () => {
    for (const mode of MODES) {
      const sigOf = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
      const seen = new Set<string>();
      for (const t of positionsOf(mode)) {
        const sig = sigOf(t.fen);
        // cancel: keep/remove одной базовой позиции намеренно делят fen —
        // не считаем это дубликатом (см. пояснение в build-premove-pool.mjs).
        const base = t.id.replace(/-(keep|remove)$/, '');
        const key = mode === 'cancel' ? `${base}:${sig}` : sig;
        if (mode !== 'cancel') {
          expect(seen.has(key), `${t.id} дублирует уже включённую позицию`).toBe(false);
        }
        seen.add(key);
      }
    }
  });
});
