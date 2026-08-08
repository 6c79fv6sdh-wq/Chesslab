import { describe, it, expect } from 'vitest';
import { countCorrections, pathEfficiency, randomPair } from '../src/modules/motorics';
import { keyFromPoint, squareCenter, type PointerSample } from '../src/modules/motorics-geometry';
import { directionBetween, squareDistance } from '../src/core/chess';

const rect = { left: 0, top: 0, width: 800, height: 800 };

const path = (pts: Array<[number, number]>): PointerSample[] =>
  pts.map(([x, y], i) => ({ x, y, t: i * 10 }));

describe('геометрия доски', () => {
  it('точка в клетку при ориентации белых', () => {
    expect(keyFromPoint(50, 750, rect, 'white')).toBe('a1');
    expect(keyFromPoint(50, 50, rect, 'white')).toBe('a8');
    expect(keyFromPoint(750, 750, rect, 'white')).toBe('h1');
  });

  it('точка в клетку при ориентации чёрных зеркально', () => {
    expect(keyFromPoint(750, 50, rect, 'black')).toBe('a1');
    expect(keyFromPoint(50, 750, rect, 'black')).toBe('h8');
  });

  it('точка вне доски даёт null', () => {
    expect(keyFromPoint(-1, 400, rect, 'white')).toBeNull();
    expect(keyFromPoint(400, 800, rect, 'white')).toBeNull();
  });

  it('центр клетки и обратное преобразование согласованы', () => {
    for (const key of ['a1', 'e4', 'h8', 'd7', 'b3']) {
      for (const orientation of ['white', 'black'] as const) {
        const c = squareCenter(key, rect, orientation);
        expect(keyFromPoint(c.x, c.y, rect, orientation)).toBe(key);
      }
    }
  });
});

describe('эффективность траектории', () => {
  it('прямая линия даёт 1', () => {
    const eff = pathEfficiency(path([[0, 0], [50, 0], [100, 0]]));
    expect(eff).toBeCloseTo(1, 6);
  });

  it('крюк снижает эффективность', () => {
    const eff = pathEfficiency(path([[0, 0], [0, 100], [100, 100]]));
    expect(eff).toBeCloseTo(Math.hypot(100, 100) / 200, 6);
    expect(eff!).toBeLessThan(1);
  });

  it('меньше двух точек — нет значения', () => {
    expect(pathEfficiency(path([[0, 0]]))).toBeNull();
  });
});

describe('коррекции у цели', () => {
  const target = { x: 100, y: 0 };

  it('чистое попадание без доводки', () => {
    expect(countCorrections(path([[0, 0], [50, 0], [90, 0], [100, 0]]), target, 25)).toBe(0);
  });

  it('перелёт и возврат считается одной коррекцией', () => {
    const p = path([[0, 0], [60, 0], [95, 0], [115, 0], [100, 0]]);
    expect(countCorrections(p, target, 25)).toBe(1);
  });

  it('две доводки считаются дважды', () => {
    const p = path([[0, 0], [95, 0], [115, 0], [98, 0], [112, 0], [100, 0]]);
    expect(countCorrections(p, target, 25)).toBe(2);
  });
});

describe('генерация пар', () => {
  it('источник и цель всегда разные и на доске', () => {
    let s = 12345;
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    for (let i = 0; i < 500; i++) {
      const { source, target } = randomPair(rnd);
      expect(source).not.toBe(target);
      expect(source).toMatch(/^[a-h][1-8]$/);
      expect(target).toMatch(/^[a-h][1-8]$/);
    }
  });
});

describe('классификация ходов', () => {
  it('расстояние в клетках', () => {
    expect(squareDistance('a1', 'a2')).toBe(1);
    expect(squareDistance('a1', 'h8')).toBe(7);
    expect(squareDistance('d4', 'f5')).toBe(2);
  });

  it('направления', () => {
    expect(directionBetween('a1', 'h1')).toBe('горизонталь');
    expect(directionBetween('a1', 'a8')).toBe('вертикаль');
    expect(directionBetween('a1', 'h8')).toBe('диагональ');
    expect(directionBetween('d4', 'e6')).toBe('конь');
    expect(directionBetween('d4', 'f7')).toBe('прочее');
  });
});
