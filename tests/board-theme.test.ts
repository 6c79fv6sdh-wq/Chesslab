import { describe, it, expect } from 'vitest';
import { BOARD_THEMES, PIECE_SETS, boardImage, boardTheme, pieceSet } from '../src/board/theme';
import { DEFAULT_CALIBRATION, normalizeCalibration } from '../src/core/settings';

describe('оформление доски', () => {
  it('идентификаторы тем и наборов уникальны', () => {
    expect(new Set(BOARD_THEMES.map((t) => t.id)).size).toBe(BOARD_THEMES.length);
    expect(new Set(PIECE_SETS.map((p) => p.id)).size).toBe(PIECE_SETS.length);
  });

  it('у каждой темы заданы оба цвета полей и подсветка', () => {
    for (const t of BOARD_THEMES) {
      expect(t.light, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.dark, t.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.accent, t.id).toMatch(/^\d+,\s*\d+,\s*\d+$/);
    }
  });

  it('у каждого набора фигур указан автор и лицензия', () => {
    for (const p of PIECE_SETS) expect(p.credit.length, p.id).toBeGreaterThan(5);
  });

  it('картинка полей содержит цвет тёмного поля', () => {
    const t = boardTheme('blue');
    expect(boardImage(t)).toContain(t.dark.replace('#', '%23'));
  });

  it('неизвестное оформление откатывается к классике', () => {
    expect(boardTheme('нет такой').id).toBe(BOARD_THEMES[0].id);
    expect(pieceSet('нет такого').id).toBe(PIECE_SETS[0].id);
    const c = normalizeCalibration({ boardTheme: 'нет такой', pieceSet: 'нет такого' });
    expect(c.boardTheme).toBe(DEFAULT_CALIBRATION.boardTheme);
    expect(c.pieceSet).toBe(DEFAULT_CALIBRATION.pieceSet);
  });

  it('сохранённое оформление переживает нормализацию', () => {
    const c = normalizeCalibration({ boardTheme: 'graphite', pieceSet: 'merida' });
    expect(c.boardTheme).toBe('graphite');
    expect(c.pieceSet).toBe('merida');
  });
});
