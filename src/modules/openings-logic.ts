import type { OpeningNodeStat } from '../core/db';
import type { OpeningLine } from '../data/repertoire';
import { median } from '../core/stats';

/** Во сколько раз медиана узла должна превысить общую, чтобы стать заминкой. */
export const HITCH_FACTOR = 1.5;

/** Насколько чаще выпадает линия, в которой есть заминки. */
export const HITCH_WEIGHT = 4;

export interface Hitch {
  path: string;
  expectedSan: string;
  medianMs: number;
}

/**
 * Заминки: узлы, чья медиана задержки выше полутора общих медиан
 * по репертуару. Общая медиана считается по медианам узлов, чтобы
 * один зазубренный узел с сотней замеров не перевешивал остальные.
 */
export function computeHitches(nodes: OpeningNodeStat[]): Hitch[] {
  const withMedian = nodes
    .map((n) => ({ node: n, med: median(n.samples) }))
    .filter((x): x is { node: OpeningNodeStat; med: number } => x.med !== null);
  if (!withMedian.length) return [];
  const overall = median(withMedian.map((x) => x.med));
  if (overall === null) return [];
  const threshold = overall * HITCH_FACTOR;
  return withMedian
    .filter((x) => x.med > threshold)
    .map((x) => ({ path: x.node.path, expectedSan: x.node.expectedSan, medianMs: x.med }))
    .sort((a, b) => b.medianMs - a.medianMs);
}

/** Путь до узла — ходы SAN через пробел, сделанные ДО этого хода. */
export function nodePath(sans: string[], index: number): string {
  return sans.slice(0, index).join(' ');
}

/** Есть ли в линии хотя бы один узел-заминка. */
export function lineHasHitch(line: OpeningLine, hitchPaths: Set<string>): boolean {
  for (let i = 0; i < line.sans.length; i++) {
    if (hitchPaths.has(nodePath(line.sans, i))) return true;
  }
  return false;
}

/**
 * Выбор линии: линии с заминками весят больше, поэтому выпадают чаще.
 */
export function pickLine(
  lines: OpeningLine[],
  hitchPaths: Set<string>,
  rnd: () => number,
): OpeningLine {
  const weights = lines.map((l) => (lineHasHitch(l, hitchPaths) ? HITCH_WEIGHT : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < lines.length; i++) {
    r -= weights[i];
    if (r < 0) return lines[i];
  }
  return lines[lines.length - 1];
}

/** Индексы ходов, которые в этой линии делает пользователь. */
export function userMoveIndices(sansLength: number, userColor: 'white' | 'black'): number[] {
  const out: number[] = [];
  for (let i = 0; i < sansLength; i++) {
    const mover = i % 2 === 0 ? 'white' : 'black';
    if (mover === userColor) out.push(i);
  }
  return out;
}
