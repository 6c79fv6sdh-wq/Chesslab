import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { BOUNDS, flushRender, mockBounds } from './helpers/dom';
import { Board } from '../src/board/board';
import { INITIAL_FEN } from '../src/core/chess';

/**
 * Регрессия на сломанный premove.
 *
 * Chessground разрешает выбрать фигуру для премува только когда
 * movable.color совпадает с цветом фигуры (см. isPremovable в board.ts).
 * Раньше модуль обнулял movableColor на время хода соперника — именно тогда,
 * когда премув и нужен, — и поставить его было физически невозможно.
 */

let board: Board;

afterEach(() => {
  board?.destroy();
  document.body.innerHTML = '';
});

beforeAll(() => mockBounds(BOUNDS));

function mount(premovable: boolean): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  board = new Board(host, {
    orientation: 'white',
    size: BOUNDS,
    coordinates: false,
    inputMode: 'both',
    animation: false,
    premovable,
  });
  return host;
}

describe('premove на доске', () => {
  it('во время хода соперника фигуру можно выбрать и премув подсвечивается', async () => {
    mount(true);
    // Ход чёрных (соперник), пользователь играет белыми.
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
    });
    await flushRender();

    board.api.selectSquare('g1');
    await flushRender();

    const dests = board.api.state.premovable.dests;
    expect(dests, 'у коня g1 должны быть поля для премува').toBeDefined();
    expect(dests!.length).toBeGreaterThan(0);
    expect(dests).toContain('f3');
  });

  it('премув реально ставится и виден на доске', async () => {
    const host = mount(true);
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
    });
    await flushRender();

    board.api.selectSquare('e2');
    await flushRender();
    board.api.selectSquare('e4');
    await flushRender();

    expect(board.hasPremove(), 'премув должен быть записан в состояние').toBe(true);
    expect(board.api.state.premovable.current).toEqual(['e2', 'e4']);
    expect(host.querySelectorAll('cg-board square.current-premove').length).toBe(2);
  });

  it('обычный ход за соперника всё равно запрещён', async () => {
    mount(true);
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
      dests: new Map(),
    });
    await flushRender();

    // Чёрные фигуры пользователю недоступны: это чужой цвет.
    board.api.selectSquare('e7');
    await flushRender();
    expect(board.api.state.premovable.dests).toBeUndefined();

    // И своей фигурой сходить по-настоящему нельзя, пока не его очередь.
    board.api.selectSquare('e2');
    await flushRender();
    expect(board.api.state.movable.dests?.get('e2') ?? []).toHaveLength(0);
  });

  it('на своём ходу премува нет, есть обычные ходы', async () => {
    mount(true);
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'white',
      movableColor: 'white',
      dests: new Map([['e2', ['e3', 'e4']]]),
    });
    await flushRender();

    board.api.selectSquare('e2');
    await flushRender();
    expect(board.api.state.premovable.dests).toBeUndefined();
    expect(board.api.state.movable.dests?.get('e2')).toEqual(['e3', 'e4']);
  });

  it('когда premove выключен, подсветки премува не появляется', async () => {
    mount(false);
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
    });
    await flushRender();
    board.api.selectSquare('g1');
    await flushRender();
    expect(board.api.state.premovable.dests).toBeUndefined();
  });
});
