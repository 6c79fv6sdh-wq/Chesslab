import type { Color } from 'chessops/types';

/** Пустая доска: только расстановка, Chessground большего и не просит. */
export const EMPTY_BOARD_FEN = '8/8/8/8/8/8/8/8';

export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function boardRect(wrap: HTMLElement): Rect {
  const r = wrap.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * Клетка под точкой экрана. Вне доски — null.
 * Ориентация учитывается явно, умолчаний нет.
 */
export function keyFromPoint(
  clientX: number,
  clientY: number,
  rect: Rect,
  orientation: Color,
): string | null {
  const dx = clientX - rect.left;
  const dy = clientY - rect.top;
  if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) return null;
  const col = Math.floor((dx / rect.width) * 8);
  const row = Math.floor((dy / rect.height) * 8);
  const file = orientation === 'white' ? col : 7 - col;
  const rank = orientation === 'white' ? 7 - row : row;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return String.fromCharCode(97 + file) + String(rank + 1);
}

/** Центр клетки в экранных координатах. */
export function squareCenter(key: string, rect: Rect, orientation: Color): { x: number; y: number } {
  const file = key.charCodeAt(0) - 97;
  const rank = key.charCodeAt(1) - 49;
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  const step = rect.width / 8;
  return { x: rect.left + (col + 0.5) * step, y: rect.top + (row + 0.5) * step };
}
