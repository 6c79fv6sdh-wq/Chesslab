import { describe, it, expect } from 'vitest';
import {
  HITCH_FACTOR,
  computeHitches,
  lineHasHitch,
  nodePath,
  pickLine,
  userMoveIndices,
} from '../src/modules/openings-logic';
import type { OpeningNodeStat } from '../src/core/db';
import type { OpeningLine } from '../src/data/repertoire';

const node = (path: string, samples: number[]): OpeningNodeStat => ({
  id: `rep|${path}`,
  repertoireId: 'rep',
  path,
  expectedSan: 'e4',
  samples,
  updatedAt: 0,
});

describe('заминки', () => {
  it('пустой набор узлов заминок не даёт', () => {
    expect(computeHitches([])).toEqual([]);
  });

  it('узел медленнее полутора медиан помечается заминкой', () => {
    const nodes = [
      node('a', [100, 100, 100]),
      node('b', [100, 100, 100]),
      node('c', [100, 100, 100]),
      node('slow', [400, 400, 400]),
    ];
    const hitches = computeHitches(nodes);
    expect(hitches.map((h) => h.path)).toEqual(['slow']);
  });

  it('узел ровно на границе заминкой не считается', () => {
    const nodes = [node('a', [100]), node('b', [100]), node('c', [100 * HITCH_FACTOR])];
    expect(computeHitches(nodes).map((h) => h.path)).toEqual([]);
  });

  it('заминки отсортированы от самой медленной', () => {
    // Медианы узлов: 100, 100, 100, 300, 900. Общая медиана 100,
    // порог 150 — быстрыми остаются только первые три.
    const nodes = [
      node('a', [100]),
      node('b', [100]),
      node('c', [100]),
      node('slow1', [300]),
      node('slow2', [900]),
    ];
    expect(computeHitches(nodes).map((h) => h.path)).toEqual(['slow2', 'slow1']);
  });

  it('узлы без замеров игнорируются', () => {
    expect(computeHitches([node('a', []), node('b', [])])).toEqual([]);
  });
});

describe('пути узлов', () => {
  it('путь — это ходы до текущего', () => {
    const sans = ['e4', 'e5', 'Nf3'];
    expect(nodePath(sans, 0)).toBe('');
    expect(nodePath(sans, 1)).toBe('e4');
    expect(nodePath(sans, 2)).toBe('e4 e5');
  });
});

describe('выбор линии', () => {
  const lines: OpeningLine[] = [
    { id: 'l1', name: 'первая', sans: ['e4', 'e5', 'Nf3'] },
    { id: 'l2', name: 'вторая', sans: ['d4', 'd5', 'c4'] },
  ];

  it('линия с заминкой определяется по любому её узлу', () => {
    expect(lineHasHitch(lines[0], new Set(['e4']))).toBe(true);
    expect(lineHasHitch(lines[0], new Set([''])), 'начальный узел тоже считается').toBe(true);
    expect(lineHasHitch(lines[1], new Set(['e4']))).toBe(false);
  });

  it('без заминок выбор равномерный', () => {
    const counts = new Map<string, number>();
    let s = 1;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 4000; i++) {
      const l = pickLine(lines, new Set(), rnd);
      counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
    }
    const a = counts.get('l1') ?? 0;
    const b = counts.get('l2') ?? 0;
    expect(Math.abs(a - b) / 4000).toBeLessThan(0.06);
  });

  it('линия с заминкой выпадает заметно чаще', () => {
    const counts = new Map<string, number>();
    let s = 42;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    // Заминка на узле «d4 d5» — он есть только во второй линии.
    for (let i = 0; i < 4000; i++) {
      const l = pickLine(lines, new Set(['d4 d5']), rnd);
      counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
    }
    expect(counts.get('l2') ?? 0).toBeGreaterThan(counts.get('l1') ?? 0);
  });
});

describe('чей ход в линии', () => {
  it('белыми пользователь ходит на чётных индексах', () => {
    expect(userMoveIndices(6, 'white')).toEqual([0, 2, 4]);
  });

  it('чёрными — на нечётных', () => {
    expect(userMoveIndices(6, 'black')).toEqual([1, 3, 5]);
  });
});
