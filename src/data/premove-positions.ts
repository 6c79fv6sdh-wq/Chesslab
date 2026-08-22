import type { Color } from 'chessops/types';
import {
  PREMOVE_FORCED_CAPTURE_POOL,
  PREMOVE_SAFE_UNSAFE_POOL,
  PREMOVE_CANCEL_POOL,
} from './premove-pool';

export type PremoveMode = 'forced-capture' | 'safe-unsafe' | 'cancel';

export const PREMOVE_MODE_LABELS: Record<PremoveMode, string> = {
  'forced-capture': 'Форсированное взятие',
  'safe-unsafe': 'Safe и unsafe',
  cancel: 'Отмена',
};

/** Реальная партия, из которой взята позиция — обязательное поле для каждой задачи. */
export interface PremoveSource {
  white: string;
  black: string;
  event: string;
  date: string;
  /** Номер полухода, на котором стоит fen задачи (соперник вот-вот сделает следующий ход). */
  ply: number;
}

/** Метаданные офлайн-проверки Stockfish — версия и глубина, с которыми считались оценки. */
export interface PremoveEvalMeta {
  engine: string;
  depth: number;
}

/**
 * Задание пула Premove.
 *
 * Каждая задача пришла из tools/build-premove-pool.mjs: позиция взята из
 * реальной партии (source), ход соперника и ответ пользователя пересчитаны
 * и перепроверены chessops независимо от исходных данных, а числовые
 * критерии (уникальность взятия, пороги 0.4/1.5 пешки, натуральность
 * альтернатив) — офлайн-анализом Stockfish (evalMeta). Ни одно из этих
 * полей не пишется руками — см. src/data/premove-validator.ts за формулами
 * и tools/build-premove-pool.mjs за самим прогоном.
 */
export interface PremoveTask {
  id: string;
  mode: PremoveMode;
  /** Позиция, в которой ход делает соперник. */
  fen: string;
  /** Цвет, за который играет пользователь. Ориентация доски берётся отсюда. */
  userColor: Color;
  /** Ожидаемый ход соперника. Легален в fen. */
  expectedUci: string;
  expectedSan: string;
  /** Обсуждаемый ответ/premove пользователя. Легален в позиции после expectedUci. */
  answerUci: string;
  answerSan: string;
  /** Верно ли ставить/оставлять premove в этой задаче. */
  shouldPremove?: boolean;
  /** Только safe-unsafe: опасная альтернатива соперника, которая наказывает premove. */
  dangerousUci?: string;
  dangerousSan?: string;
  /** Только cancel: что правильно сделать — оставить или снять. */
  correctAction?: 'keep' | 'remove';
  /** Только cancel + correctAction === 'remove': реально сыгранный неожиданный ход. */
  unexpectedUci?: string;
  unexpectedSan?: string;
  /** Автособранное из SAN описание — см. describe* в premove-validator.ts. */
  comment: string;
  source: PremoveSource;
  evalMeta: PremoveEvalMeta;
  /** Пешки, с точки зрения пользователя — контекст для отчётов/тестов, не для UI. */
  evalPawns?: number;
}

export function positionsOf(mode: PremoveMode): PremoveTask[] {
  switch (mode) {
    case 'forced-capture':
      return PREMOVE_FORCED_CAPTURE_POOL;
    case 'safe-unsafe':
      return PREMOVE_SAFE_UNSAFE_POOL;
    case 'cancel':
      return PREMOVE_CANCEL_POOL;
  }
}
