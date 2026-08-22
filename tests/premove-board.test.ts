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

/**
 * setPremoveDests/presetPremove — добавлены для режима «Форсированное
 * взятие» и «Отмена» модуля Premove (src/modules/premove.ts). Штатная
 * геометрия Chessground для премува (см. node_modules/chessground/dist/
 * premove.js) считает клетки чисто по форме фигуры — без блокеров на
 * линии и без учёта позиции ПОСЛЕ ожидаемого хода соперника (связки,
 * шахи, реально доступные поля). Например, ладья «сквозь» свою фигуру
 * по геометрии может премувнуть, хотя реально там стоит блокер.
 * customDests подменяет это точным списком, посчитанным по правилам —
 * той же функцией dests(), что считает обычные ходы.
 */
describe('customDests и presetPremove', () => {
  it('без customDests штатная геометрия Chessground не видит блокер на линии ладьи', async () => {
    // Ладья a1, свой конь на b1 — геометрия «сквозь» слепа к блокеру.
    mount(true);
    board.setPosition({
      fen: '4k3/8/8/8/8/8/8/RN2K3 b - - 0 1',
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
    });
    await flushRender();
    board.api.selectSquare('a1');
    await flushRender();
    expect(board.api.state.premovable.dests).toContain('c1');
  });

  it('с customDests из настоящих dests() блокер на линии учитывается', async () => {
    mount(true);
    board.setPosition({
      fen: '4k3/8/8/8/8/8/8/RN2K3 b - - 0 1',
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
    });
    board.setPremoveDests(new Map([['a1', ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']]]));
    await flushRender();
    board.api.selectSquare('a1');
    await flushRender();
    // Chessground при заданном customDests оставляет state.premovable.dests
    // как есть (см. setSelected в board.js) — реальную проверку и отрисовку
    // подсказок он ведёт через customDests.get(orig) напрямую.
    const allowed = board.api.state.premovable.customDests?.get('a1');
    expect(allowed).not.toContain('c1');
    expect(allowed).toContain('a8');

    board.api.selectSquare('a8');
    await flushRender();
    expect(board.hasPremove()).toBe(true);
    expect(board.api.state.premovable.current).toEqual(['a1', 'a8']);
  });

  it('presetPremove показывает премув на доске без действий пользователя', async () => {
    mount(true);
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'black',
      movableColor: 'white',
    });
    await flushRender();
    expect(board.hasPremove()).toBe(false);
    board.presetPremove('e2', 'e4');
    await flushRender();
    expect(board.hasPremove()).toBe(true);
    expect(board.api.state.premovable.current).toEqual(['e2', 'e4']);
  });

  it('повторный клик по премуву заменяет очередь, а не копит её (двойной клик не создаёт две очереди)', async () => {
    mount(true);
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
    expect(board.api.state.premovable.current).toEqual(['e2', 'e4']);

    // Второй премув другой фигурой — старая очередь должна замениться,
    // а не остаться висеть вместе с новой (premovable.current — не массив).
    board.api.selectSquare('g1');
    await flushRender();
    board.api.selectSquare('f3');
    await flushRender();
    expect(board.api.state.premovable.current).toEqual(['g1', 'f3']);
  });

  it('премув не исполняется дважды: второй playPremove() после первого — no-op', async () => {
    mount(true);
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
    expect(board.hasPremove()).toBe(true);

    // Реальный ход соперника — теперь можно исполнить премув.
    board.setPosition({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'.replace('w', 'w'),
      orientation: 'white',
      turnColor: 'white',
      movableColor: 'white',
      dests: new Map([['e2', ['e3', 'e4']]]),
    });
    const first = board.playPremove();
    expect(first).toBe(true);
    expect(board.hasPremove()).toBe(false);

    const second = board.playPremove();
    expect(second).toBe(false);
  });
});
