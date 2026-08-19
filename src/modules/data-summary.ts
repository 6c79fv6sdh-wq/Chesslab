import type { MeasurementRecord, ModuleId, OpeningNodeStat } from '../core/db';
import { groupBy, median, p90 } from '../core/stats';

export const MODULE_LABELS: Record<ModuleId, string> = {
  motorics: 'Моторика',
  premove: 'Premove',
  reaction: 'Тактика',
  openings: 'Дебюты',
  scramble: 'Спарринг',
};

/**
 * Основная временная метрика замера. У каждого модуля она своя, поэтому
 * сводная таблица опирается на это единое правило.
 */
export function primaryLatency(m: MeasurementRecord): number | null {
  const d = m.data;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (m.module) {
    case 'motorics':
      return num(d.totalMs);
    case 'premove':
      // В режиме отмены смысл имеет время снятия, в остальных — постановки.
      return num(d.cancelLatencyMs) ?? num(d.setLatencyMs);
    case 'reaction':
      return num(d.latencyMs);
    case 'openings':
      return num(d.latencyMs);
    case 'scramble':
      return num(d.moveMs);
  }
}

/** Верен ли замер. null — у модуля нет понятия правильности. */
export function isCorrect(m: MeasurementRecord): boolean | null {
  const d = m.data;
  if (m.module === 'motorics') return typeof d.misses === 'number' ? d.misses === 0 : null;
  if (typeof d.correct === 'boolean') return d.correct;
  return null;
}

export interface SummaryRow {
  key: string;
  attempts: number;
  medianMs: number | null;
  p90Ms: number | null;
  accuracy: number | null;
}

function rowOf(key: string, items: MeasurementRecord[]): SummaryRow {
  const lat = items.map(primaryLatency).filter((v): v is number => v !== null);
  const flags = items.map(isCorrect).filter((v): v is boolean => v !== null);
  return {
    key,
    attempts: items.length,
    medianMs: median(lat),
    p90Ms: p90(lat),
    accuracy: flags.length ? flags.filter(Boolean).length / flags.length : null,
  };
}

/** Сводка по модулю с разбивкой по режимам. */
export function summarizeModule(measurements: MeasurementRecord[], module: ModuleId): SummaryRow[] {
  const mine = measurements.filter((m) => m.module === module);
  if (!mine.length) return [];
  const rows = [...groupBy(mine, (m) => m.mode)]
    .map(([mode, items]) => rowOf(mode, items))
    .sort((a, b) => a.key.localeCompare(b.key));
  return [rowOf('все режимы', mine), ...rows];
}

/** Сводка верхнего уровня: по одной строке на модуль. */
export function summarizeAll(measurements: MeasurementRecord[]): SummaryRow[] {
  return (Object.keys(MODULE_LABELS) as ModuleId[])
    .map((mod) => {
      const mine = measurements.filter((m) => m.module === mod);
      return { ...rowOf(MODULE_LABELS[mod], mine) };
    })
    .filter((r) => r.attempts > 0);
}

export interface MotoricsBreakdownRow {
  key: string;
  attempts: number;
  medianMs: number | null;
  p90Ms: number | null;
  accuracy: number | null;
  pathEfficiency: number | null;
  corrections: number | null;
}

function motoricsRow(key: string, items: MeasurementRecord[]): MotoricsBreakdownRow {
  const base = rowOf(key, items);
  const eff = items
    .map((m) => m.data.pathEfficiency)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const corr = items
    .map((m) => m.data.corrections)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return { ...base, pathEfficiency: median(eff), corrections: median(corr) };
}

export type MotoricsAxis = 'boardSize' | 'distance' | 'direction';

/**
 * Разбивка моторики по размеру доски, расстоянию и направлению.
 * Размер доски берётся из снимка калибровки в самом замере.
 *
 * Только режим source-target («Вектор») — ни у «Сигнала» (клик разрешён
 * где угодно на доске), ни у «Маршрута» (расстояние там — до заданной, а
 * не до фактической клетки, direction не пишется вовсе, drag — другая
 * моторика) нет одинаковой пары «расстояние/направление», подмешивать их
 * сюда значило бы засорять разбивку строкой «—» без смысла или, хуже,
 * складывать несравнимые между собой цифры в одну ячейку.
 */
export function motoricsBreakdown(
  measurements: MeasurementRecord[],
  axis: MotoricsAxis,
): MotoricsBreakdownRow[] {
  const mine = measurements.filter((m) => m.module === 'motorics' && m.mode === 'source-target');
  if (!mine.length) return [];

  const keyOf = (m: MeasurementRecord): string => {
    if (axis === 'boardSize') return `${m.calibration.boardSize} px`;
    if (axis === 'distance') return String(m.data.distance ?? '—');
    return String(m.data.direction ?? '—');
  };

  const rows = [...groupBy(mine, keyOf)].map(([k, items]) => motoricsRow(k, items));

  if (axis === 'direction') return rows.sort((a, b) => b.attempts - a.attempts);
  return rows.sort((a, b) => parseFloat(a.key) - parseFloat(b.key));
}

export interface SlowNodeRow {
  repertoireId: string;
  path: string;
  expectedSan: string;
  samples: number;
  medianMs: number;
}

/** Топ самых медленных узлов дебютного дерева. */
export function slowestNodes(nodes: OpeningNodeStat[], limit = 20): SlowNodeRow[] {
  return nodes
    .map((n) => ({
      repertoireId: n.repertoireId,
      path: n.path,
      expectedSan: n.expectedSan,
      samples: n.samples.length,
      medianMs: median(n.samples),
    }))
    .filter((r): r is SlowNodeRow => r.medianMs !== null)
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, limit);
}
