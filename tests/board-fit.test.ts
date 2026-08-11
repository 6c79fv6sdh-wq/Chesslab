import { describe, it, expect } from 'vitest';
import {
  BOARD_SIZE_FLOOR,
  BOARD_SIZE_MAX,
  BOARD_SIZE_MIN,
  DEFAULT_CALIBRATION,
  fitBoardSize,
} from '../src/core/settings';
import { measuredCalibration } from '../src/core/session';

describe('fitBoardSize: доска подгоняется под ширину экрана', () => {
  it('на широком экране рисует ровно желаемый размер', () => {
    expect(fitBoardSize(480, 1000)).toBe(480);
    expect(fitBoardSize(BOARD_SIZE_MAX, 1200)).toBe(BOARD_SIZE_MAX);
  });

  it('на узком экране ужимает до доступной ширины', () => {
    // iPhone 390 px: за вычетом отступов страницы и панели остаётся ~352.
    expect(fitBoardSize(480, 352)).toBe(352);
    expect(fitBoardSize(480, 280)).toBe(280);
  });

  it('всегда кратен 8, чтобы клетка была целым числом пикселей', () => {
    for (const avail of [301, 333, 347, 359, 411]) {
      const got = fitBoardSize(760, avail);
      expect(got % 8, `avail ${avail} -> ${got}`).toBe(0);
      expect(got).toBeLessThanOrEqual(avail);
    }
  });

  it('никогда не шире доступного места — иначе страница едет вбок', () => {
    for (let avail = 200; avail <= 900; avail += 7) {
      expect(fitBoardSize(480, avail)).toBeLessThanOrEqual(Math.max(avail, BOARD_SIZE_FLOOR));
    }
  });

  it('уходит ниже BOARD_SIZE_MIN, если экран физически уже', () => {
    // Настройка не может быть меньше 320, но экран шириной 280 не переспорить:
    // лучше вся доска целиком, чем 320 px с обрезанной вертикалью h.
    const got = fitBoardSize(BOARD_SIZE_MIN, 264);
    expect(got).toBe(264);
    expect(got).toBeLessThan(BOARD_SIZE_MIN);
  });

  it('не схлопывается в ноль на абсурдно узком месте', () => {
    expect(fitBoardSize(480, 40)).toBe(BOARD_SIZE_FLOOR);
    expect(fitBoardSize(480, 1)).toBe(BOARD_SIZE_FLOOR);
  });

  it('без замера (элемент ещё не в документе) берёт желаемый размер', () => {
    expect(fitBoardSize(480, 0)).toBe(480);
    expect(fitBoardSize(480, -10)).toBe(480);
    expect(fitBoardSize(480, Number.NaN)).toBe(480);
  });

  it('желаемый размер сначала приводится к допустимому диапазону', () => {
    expect(fitBoardSize(5000, 10000)).toBe(BOARD_SIZE_MAX);
    expect(fitBoardSize(10, 10000)).toBe(BOARD_SIZE_MIN);
    expect(fitBoardSize(Number.NaN, 10000)).toBe(DEFAULT_CALIBRATION.boardSize);
  });

  it('монотонен: чем шире экран, тем не меньше доска', () => {
    let prev = 0;
    for (let avail = 100; avail <= 1000; avail += 13) {
      const got = fitBoardSize(BOARD_SIZE_MAX, avail);
      expect(got, `avail ${avail}`).toBeGreaterThanOrEqual(prev);
      prev = got;
    }
  });
});

describe('в замер пишется фактический размер доски, а не желаемый', () => {
  const cal = { ...DEFAULT_CALIBRATION, boardSize: 480, pointerLabel: 'DPI 1600' };

  it('подменяет boardSize на тот, что реально отрисован', () => {
    const rendered = fitBoardSize(cal.boardSize, 352);
    expect(measuredCalibration(cal, rendered).boardSize).toBe(352);
  });

  it('остальные поля калибровки не трогает', () => {
    const got = measuredCalibration(cal, 352);
    expect(got.inputMode).toBe(cal.inputMode);
    expect(got.coordinates).toBe(cal.coordinates);
    expect(got.deviceProfile).toBe(cal.deviceProfile);
    expect(got.pointerLabel).toBe('DPI 1600');
  });

  it('не меняет исходную настройку: желаемый размер остаётся у пользователя', () => {
    measuredCalibration(cal, 280);
    expect(cal.boardSize).toBe(480);
  });
});
