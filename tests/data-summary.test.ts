import { describe, it, expect } from 'vitest';
import {
  isCorrect,
  motoricsBreakdown,
  primaryLatency,
  slowestNodes,
  summarizeAll,
  summarizeModule,
} from '../src/modules/data-summary';
import { parseBundle } from '../src/core/db';
import type { MeasurementRecord, ModuleId, OpeningNodeStat } from '../src/core/db';
import { DEFAULT_CALIBRATION } from '../src/core/settings';
import { median, p90, quantile } from '../src/core/stats';

let counter = 0;
const rec = (
  module: ModuleId,
  mode: string,
  data: Record<string, unknown>,
  boardSize = 480,
): MeasurementRecord => ({
  id: `m${counter++}`,
  sessionId: 's1',
  module,
  mode,
  ts: 0,
  calibration: { ...DEFAULT_CALIBRATION, boardSize },
  data,
});

describe('статистика', () => {
  it('медиана и P90 на известном наборе', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(median(xs)).toBe(5.5);
    expect(p90(xs)).toBeCloseTo(9.1, 6);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(10);
  });

  it('пустой набор даёт null', () => {
    expect(median([])).toBeNull();
    expect(p90([])).toBeNull();
  });
});

describe('основная метрика замера', () => {
  it('у каждого модуля своя', () => {
    expect(primaryLatency(rec('motorics', 'source-target', { totalMs: 800 }))).toBe(800);
    expect(primaryLatency(rec('reaction', 'delta:300', { latencyMs: 420 }))).toBe(420);
    expect(primaryLatency(rec('openings', 'white-e4', { latencyMs: 300 }))).toBe(300);
    expect(primaryLatency(rec('scramble', 'fast:15s', { moveMs: 250 }))).toBe(250);
  });

  it('у premove в режиме отмены берётся время снятия', () => {
    expect(
      primaryLatency(rec('premove', 'cancel', { setLatencyMs: 900, cancelLatencyMs: 210 })),
    ).toBe(210);
    expect(primaryLatency(rec('premove', 'forced-capture', { setLatencyMs: 900 }))).toBe(900);
  });

  it('отсутствующая метрика даёт null', () => {
    expect(primaryLatency(rec('motorics', 'source-target', {}))).toBeNull();
  });

  it('правильность: у моторики это отсутствие промахов', () => {
    expect(isCorrect(rec('motorics', 'source-target', { misses: 0 }))).toBe(true);
    expect(isCorrect(rec('motorics', 'source-target', { misses: 2 }))).toBe(false);
    expect(isCorrect(rec('reaction', 'delta', { correct: true }))).toBe(true);
    expect(isCorrect(rec('scramble', 'fast:15s', { moveMs: 100 }))).toBeNull();
  });
});

describe('сводка по модулю', () => {
  const data = [
    rec('reaction', 'free-capture:unlimited', { latencyMs: 100, correct: true }),
    rec('reaction', 'free-capture:unlimited', { latencyMs: 300, correct: false }),
    rec('reaction', 'delta:300', { latencyMs: 500, correct: true }),
    rec('premove', 'cancel', { cancelLatencyMs: 200, correct: true }),
  ];

  it('первой идёт строка по всем режимам', () => {
    const rows = summarizeModule(data, 'reaction');
    expect(rows[0].key).toBe('все режимы');
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].medianMs).toBe(300);
    expect(rows[0].accuracy).toBeCloseTo(2 / 3, 6);
  });

  it('режимы разложены отдельно', () => {
    const rows = summarizeModule(data, 'reaction');
    const free = rows.find((r) => r.key === 'free-capture:unlimited')!;
    expect(free.attempts).toBe(2);
    expect(free.medianMs).toBe(200);
    expect(free.accuracy).toBe(0.5);
  });

  it('модуль без замеров даёт пустой список', () => {
    expect(summarizeModule(data, 'scramble')).toEqual([]);
  });

  it('сводка верхнего уровня показывает только непустые модули', () => {
    const rows = summarizeAll(data);
    expect(rows.map((r) => r.key)).toEqual(['Premove', 'Реакция']);
  });
});

describe('разрезы моторики', () => {
  const data = [
    rec('motorics', 'source-target', { totalMs: 700, misses: 0, distance: 2, direction: 'диагональ', pathEfficiency: 0.9, corrections: 0 }, 320),
    rec('motorics', 'source-target', { totalMs: 900, misses: 1, distance: 2, direction: 'диагональ', pathEfficiency: 0.7, corrections: 2 }, 320),
    rec('motorics', 'source-target', { totalMs: 1100, misses: 0, distance: 5, direction: 'горизонталь', pathEfficiency: 0.8, corrections: 1 }, 760),
  ];

  it('по размеру доски', () => {
    const rows = motoricsBreakdown(data, 'boardSize');
    expect(rows.map((r) => r.key)).toEqual(['320 px', '760 px']);
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].medianMs).toBe(800);
    expect(rows[0].accuracy).toBe(0.5);
    expect(rows[0].pathEfficiency).toBeCloseTo(0.8, 6);
    expect(rows[0].corrections).toBe(1);
  });

  it('по расстоянию, отсортировано по возрастанию', () => {
    const rows = motoricsBreakdown(data, 'distance');
    expect(rows.map((r) => r.key)).toEqual(['2', '5']);
  });

  it('по направлению', () => {
    const rows = motoricsBreakdown(data, 'direction');
    expect(rows.map((r) => r.key).sort()).toEqual(['горизонталь', 'диагональ']);
  });

  it('замеры других модулей в разрезы не попадают', () => {
    const mixed = [...data, rec('reaction', 'delta', { latencyMs: 1 })];
    const rows = motoricsBreakdown(mixed, 'boardSize');
    expect(rows.reduce((a, r) => a + r.attempts, 0)).toBe(3);
  });
});

describe('самые медленные узлы дебютов', () => {
  const node = (path: string, samples: number[]): OpeningNodeStat => ({
    id: `white-e4|${path}`,
    repertoireId: 'white-e4',
    path,
    expectedSan: 'Nf3',
    samples,
    updatedAt: 0,
  });

  it('сортировка по убыванию медианы', () => {
    const rows = slowestNodes([node('a', [100]), node('b', [900]), node('c', [400])]);
    expect(rows.map((r) => r.path)).toEqual(['b', 'c', 'a']);
    expect(rows[0].medianMs).toBe(900);
  });

  it('узлы без замеров отбрасываются', () => {
    expect(slowestNodes([node('a', [])])).toEqual([]);
  });

  it('лимит соблюдается', () => {
    const many = Array.from({ length: 50 }, (_, i) => node(`p${i}`, [i * 10 + 1]));
    expect(slowestNodes(many, 5)).toHaveLength(5);
  });
});

describe('разбор выгрузки', () => {
  const good = JSON.stringify({
    app: 'sciencechess-hyperlab',
    version: 1,
    exportedAt: 1,
    calibration: { boardSize: 999, inputMode: 'select', coordinates: false, deviceProfile: 'pc-mouse', pointerLabel: 'DPI 800' },
    sessions: [],
    measurements: [],
    openingNodes: [],
  });

  it('корректная выгрузка читается, размер доски приводится к диапазону', () => {
    const b = parseBundle(good);
    expect(b.calibration.boardSize).toBe(760);
    expect(b.calibration.inputMode).toBe('select');
    expect(b.calibration.pointerLabel).toBe('DPI 800');
  });

  it('чужой формат отвергается', () => {
    expect(() => parseBundle(JSON.stringify({ app: 'other', sessions: [], measurements: [] }))).toThrow(
      /app/,
    );
  });

  it('битый JSON отвергается', () => {
    expect(() => parseBundle('{')).toThrow();
  });

  it('выгрузка без массивов отвергается', () => {
    expect(() => parseBundle(JSON.stringify({ app: 'sciencechess-hyperlab' }))).toThrow(
      /sessions/,
    );
  });
});
