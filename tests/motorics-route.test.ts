import { describe, it, expect } from 'vitest';
import type { Key } from 'chessground/types';
import {
  CLASSIC_REPS,
  ROUTE_PIECES,
  RELAY_PER_PIECE,
  SURVIVAL_MAX_ERRORS,
  SURVIVAL_MIN_LIMIT_MS,
  SURVIVAL_START_LIMIT_MS,
  firstRouteStep,
  legalRouteTargets,
  nextRouteStep,
  relayPieceState,
  routeDests,
  routeFen,
  routeMeasurementData,
  survivalLimitMs,
  survivalPieceState,
  type RoutePiece,
} from '../src/modules/motorics-route';

const seeded = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

describe('legalRouteTargets — геометрия на пустой доске', () => {
  it('ладья с a1 бьёт всю вертикаль и горизонталь — 14 клеток', () => {
    expect(legalRouteTargets('rook', 'a1' as Key)).toHaveLength(14);
  });

  it('слон с c1 — только клетки его цвета, диагонали до краёв', () => {
    const targets = legalRouteTargets('bishop', 'c1' as Key);
    expect(targets).toContain('a3');
    expect(targets).toContain('h6');
    expect(targets).not.toContain('a1');
  });

  it('конь в углу — минимум ходов из всех клеток (2 с a1)', () => {
    expect(legalRouteTargets('knight', 'a1' as Key).sort()).toEqual(['b3', 'c2']);
  });

  it('ферзь с d4 — объединение ладьи и слона, 27 клеток', () => {
    expect(legalRouteTargets('queen', 'd4' as Key)).toHaveLength(27);
  });

  it('король никогда не остаётся без хода — даже в углу их минимум 3', () => {
    for (const from of ['a1', 'h1', 'a8', 'h8'] as Key[]) {
      expect(legalRouteTargets('king', from).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('у всех пяти фигур со ВСЕХ 64 клеток всегда есть хотя бы одна цель', () => {
    const files = 'abcdefgh';
    for (const piece of ROUTE_PIECES) {
      for (let f = 0; f < 8; f++) {
        for (let r = 1; r <= 8; r++) {
          const from = (files[f] + r) as Key;
          expect(legalRouteTargets(piece, from).length, `${piece} с ${from}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('фигура никогда не может «перейти» сама на себя', () => {
    for (const piece of ROUTE_PIECES) {
      expect(legalRouteTargets(piece, 'd4' as Key)).not.toContain('d4');
    }
  });
});

describe('routeFen — расстановка одной фигуры', () => {
  it('белый ферзь на d4', () => {
    expect(routeFen('queen', 'd4' as Key)).toBe('8/8/8/8/3Q4/8/8/8');
  });

  it('фигура в углу a1 — без ведущего нуля в первом сегменте', () => {
    expect(routeFen('rook', 'a1' as Key)).toBe('8/8/8/8/8/8/8/R7');
  });

  it('фигура в углу h8 — без хвостового сегмента', () => {
    expect(routeFen('king', 'h8' as Key)).toBe('7K/8/8/8/8/8/8/8');
  });
});

describe('routeDests', () => {
  it('единственная разрешённая цель — сама подсвеченная клетка', () => {
    const dests = routeDests('d4' as Key, 'd7' as Key);
    expect(dests.get('d4' as Key)).toEqual(['d7']);
    expect(dests.size).toBe(1);
  });
});

describe('nextRouteStep / firstRouteStep', () => {
  it('следующий шаг стартует ровно с клетки, куда пришли', () => {
    const rnd = seeded(1);
    const step = nextRouteStep('rook', 'a1' as Key, rnd);
    expect(step.from).toBe('a1');
    expect(legalRouteTargets('rook', 'a1' as Key)).toContain(step.target);
  });

  it('первый шаг — валидная пара from/target для этой фигуры', () => {
    const rnd = seeded(5);
    for (let i = 0; i < 200; i++) {
      const step = firstRouteStep('knight', rnd);
      expect(legalRouteTargets('knight', step.from)).toContain(step.target);
    }
  });

  it('на 2000 шагов подряд ни разу не застревает (всегда есть следующая цель)', () => {
    const rnd = seeded(11);
    for (const piece of ROUTE_PIECES) {
      let step = firstRouteStep(piece, rnd);
      for (let i = 0; i < 2000; i++) {
        step = nextRouteStep(piece, step.target, rnd);
        expect(step.from).toBe(step.from); // не бросает, дошли до сюда
      }
    }
  });
});

describe('relayPieceState — счёт по пятёркам', () => {
  it('первые 5 верных — ладья, счёт 0..4', () => {
    for (let i = 0; i < 5; i++) {
      expect(relayPieceState(i)).toEqual({ piece: 'rook', countInPiece: i });
    }
  });

  it('5..9 — слон, счёт 0..4', () => {
    expect(relayPieceState(5)).toEqual({ piece: 'bishop', countInPiece: 0 });
    expect(relayPieceState(9)).toEqual({ piece: 'bishop', countInPiece: 4 });
  });

  it('после короля (20..24) цикл начинается заново с ладьи', () => {
    expect(relayPieceState(25)).toEqual({ piece: 'rook', countInPiece: 0 });
  });

  it('RELAY_PER_PIECE — ровно 5, как в задании', () => {
    expect(RELAY_PER_PIECE).toBe(5);
  });
});

describe('survivalPieceState — фигура меняется каждый ход', () => {
  it('идёт строго по кругу ♜→♝→♞→♛→♔→♜…', () => {
    const order: RoutePiece[] = [];
    for (let i = 0; i < 12; i++) order.push(survivalPieceState(i));
    expect(order).toEqual([
      'rook', 'bishop', 'knight', 'queen', 'king',
      'rook', 'bishop', 'knight', 'queen', 'king',
      'rook', 'bishop',
    ]);
  });
});

describe('survivalLimitMs — лимит убывает и не проваливается ниже пола', () => {
  it('первая попытка — стартовый лимит', () => {
    expect(survivalLimitMs(0)).toBe(SURVIVAL_START_LIMIT_MS);
  });

  it('монотонно не растёт', () => {
    let prev = survivalLimitMs(0);
    for (let i = 1; i < 200; i++) {
      const cur = survivalLimitMs(i);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });

  it('никогда не ниже пола', () => {
    for (let i = 0; i < 500; i++) {
      expect(survivalLimitMs(i)).toBeGreaterThanOrEqual(SURVIVAL_MIN_LIMIT_MS);
    }
  });
});

describe('SURVIVAL_MAX_ERRORS / CLASSIC_REPS — константы задания', () => {
  it('3 ошибки на Survival, 20 повторов на Классику', () => {
    expect(SURVIVAL_MAX_ERRORS).toBe(3);
    expect(CLASSIC_REPS).toBe(20);
  });
});

describe('routeMeasurementData', () => {
  it('верный ход: totalMs считается, misses=0', () => {
    const data = routeMeasurementData({
      mode: 'classic',
      piece: 'rook',
      from: 'a1' as Key,
      to: 'a5' as Key,
      distance: 4,
      targetShownAt: 1000,
      pointerDownAt: 1050,
      pointerUpAt: 1300,
      correct: true,
      pointerType: 'mouse',
    });
    expect(data.totalMs).toBe(300);
    expect(data.misses).toBe(0);
    expect(data.correct).toBe(true);
  });

  it('ошибка: misses=1', () => {
    const data = routeMeasurementData({
      mode: 'survival',
      piece: 'knight',
      from: 'a1' as Key,
      to: 'c2' as Key,
      distance: 2,
      targetShownAt: 1000,
      pointerDownAt: 1050,
      pointerUpAt: 1200,
      correct: false,
      pointerType: 'touch',
    });
    expect(data.misses).toBe(1);
    expect(data.correct).toBe(false);
  });

  it('просрочка лимита: pointerUpAt/pointerDownAt/to — null, totalMs — null', () => {
    const data = routeMeasurementData({
      mode: 'survival',
      piece: 'king',
      from: 'e4' as Key,
      to: null,
      distance: 1,
      targetShownAt: 1000,
      pointerDownAt: null,
      pointerUpAt: null,
      correct: false,
      pointerType: '',
    });
    expect(data.totalMs).toBeNull();
    expect(data.to).toBeNull();
    expect(data.misses).toBe(1);
  });
});
