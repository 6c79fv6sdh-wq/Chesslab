import { Board } from '../../src/board/board';
import type { Color } from 'chessground/types';

export const BOUNDS = 800;

/**
 * jsdom не считает layout, поэтому getBoundingClientRect возвращает нули и
 * Chessground не может разложить фигуры по клеткам. Подставляем фиксированный
 * прямоугольник 800x800 — этого достаточно, чтобы проверить геометрию.
 */
export function mockBounds(size = BOUNDS): void {
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
      width: size,
      height: size,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

export function makeBoard(orientation: Color, coordinates = true): { board: Board; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const board = new Board(host, {
    orientation,
    size: BOUNDS,
    coordinates,
    inputMode: 'both',
    // Без анимации: иначе фигура едет из старой клетки и в момент проверки
    // стоит между полями.
    animation: false,
  });
  return { board, host };
}

/**
 * Chessground откладывает перерисовку до requestAnimationFrame, поэтому
 * после каждого set() надо дать кадру пройти.
 */
export function flushRender(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export interface RenderedPiece {
  color: string;
  role: string;
  x: number;
  y: number;
}

/** Все отрисованные фигуры с их пиксельными координатами. */
export function renderedPieces(host: HTMLElement): RenderedPiece[] {
  const out: RenderedPiece[] = [];
  for (const p of Array.from(host.querySelectorAll('piece'))) {
    const cls = Array.from(p.classList);
    if (cls.includes('ghost') || cls.includes('fading')) continue;
    const color = cls.find((c) => c === 'white' || c === 'black');
    const role = cls.find((c) =>
      ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'].includes(c),
    );
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((p as HTMLElement).style.transform);
    if (!color || !role || !m) continue;
    out.push({ color, role, x: parseFloat(m[1]), y: parseFloat(m[2]) });
  }
  return out;
}

/** Обратное преобразование пикселей в ключ клетки с учётом ориентации. */
export function keyAt(x: number, y: number, orientation: Color, size = BOUNDS): string {
  const step = size / 8;
  const col = Math.round(x / step);
  const row = Math.round(y / step);
  const file = orientation === 'white' ? col : 7 - col;
  const rank = orientation === 'white' ? 7 - row : row;
  return String.fromCharCode(97 + file) + String(rank + 1);
}

/** Карта клетка -> "цвет роль" по фактическому DOM доски. */
export function renderedBoardMap(host: HTMLElement, orientation: Color): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of renderedPieces(host)) {
    map.set(keyAt(p.x, p.y, orientation), `${p.color} ${p.role}`);
  }
  return map;
}
