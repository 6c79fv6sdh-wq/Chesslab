import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  BOUNDS,
  flushRender,
  keyAt,
  makeBoard,
  mockBounds,
  renderedBoardMap,
  renderedPieces,
} from './helpers/dom';
import { INITIAL_FEN, allLegalMoves, dests, fenOf, posFromFen, keyOf } from '../src/core/chess';
import type { Board } from '../src/board/board';

let board: Board;
let host: HTMLElement;

beforeAll(() => {
  mockBounds(BOUNDS);
});

afterEach(() => {
  board?.destroy();
  document.body.innerHTML = '';
});

function mount(orientation: 'white' | 'black'): void {
  const made = makeBoard(orientation);
  board = made.board;
  host = made.host;
}

describe('цвет фигур берётся из FEN', () => {
  beforeEach(() => mount('white'));

  it('на стартовой позиции 1 и 2 горизонтали только белые, 7 и 8 только чёрные', async () => {
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'white',
      movableColor: 'white',
    });
    await flushRender();

    const map = renderedBoardMap(host, 'white');
    expect(map.size).toBe(32);

    for (const [key, val] of map) {
      const rank = Number(key[1]);
      if (rank === 1 || rank === 2) expect(`${key}: ${val}`).toMatch(/white/);
      else if (rank === 7 || rank === 8) expect(`${key}: ${val}`).toMatch(/black/);
      else throw new Error(`фигура на неожиданной горизонтали: ${key} ${val}`);
    }
  });

  it('ни одной фигуры на доске без явного класса цвета', async () => {
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });
    await flushRender();
    // Именно фигуры доски: служебный «призрак» перетаскивания живёт
    // в cg-container и цвета не имеет по устройству Chessground.
    const all = Array.from(host.querySelectorAll('cg-board piece'));
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      const cls = Array.from(p.classList);
      expect(cls.includes('white') || cls.includes('black')).toBe(true);
    }
  });

  it('после 20 случайных ходов доска совпадает с движком по цвету и типу на каждой клетке', async () => {
    let pos = posFromFen(INITIAL_FEN);
    let rngState = 20240607;
    const rnd = () => {
      // Детерминированный LCG, чтобы падение теста воспроизводилось.
      rngState = (rngState * 1103515245 + 12345) % 2147483648;
      return rngState / 2147483648;
    };

    for (let i = 0; i < 20; i++) {
      const moves = allLegalMoves(pos);
      if (!moves.length) break;
      const mv = moves[Math.floor(rnd() * moves.length)];
      pos.play(mv);

      const fen = fenOf(pos);
      board.setPosition({
        fen,
        orientation: 'white',
        turnColor: pos.turn,
        movableColor: pos.turn,
        dests: dests(pos),
      });
      await flushRender();

      const rendered = renderedBoardMap(host, 'white');

      const expected = new Map<string, string>();
      for (const [sq, piece] of pos.board) {
        expected.set(keyOf(sq), `${piece.color} ${piece.role}`);
      }

      expect(rendered.size, `ход ${i + 1}, FEN ${fen}`).toBe(expected.size);
      for (const [key, val] of expected) {
        expect(rendered.get(key), `ход ${i + 1}, клетка ${key}, FEN ${fen}`).toBe(val);
      }
    }
  });
});

describe('ориентация', () => {
  it('при orientation black клетка a1 в правом верхнем углу', async () => {
    mount('black');
    board.setPosition({ fen: INITIAL_FEN, orientation: 'black', turnColor: 'white' });
    await flushRender();

    const pieces = renderedPieces(host);
    const a1 = pieces.find((p) => keyAt(p.x, p.y, 'black') === 'a1');
    expect(a1, 'на a1 должна быть белая ладья').toBeDefined();
    expect(a1!.color).toBe('white');
    expect(a1!.role).toBe('rook');

    const step = BOUNDS / 8;
    // Правый верхний угол: максимальный x, нулевой y.
    expect(a1!.x).toBeCloseTo(7 * step, 5);
    expect(a1!.y).toBeCloseTo(0, 5);

    // Для контраста: h8 должна оказаться в левом нижнем углу.
    const h8 = pieces.find((p) => keyAt(p.x, p.y, 'black') === 'h8');
    expect(h8).toBeDefined();
    expect(h8!.x).toBeCloseTo(0, 5);
    expect(h8!.y).toBeCloseTo(7 * step, 5);

    expect(host.querySelector('.cg-wrap')!.classList.contains('orientation-black')).toBe(true);
  });

  it('при orientation white клетка a1 в левом нижнем углу', async () => {
    mount('white');
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });
    await flushRender();
    const pieces = renderedPieces(host);
    const a1 = pieces.find((p) => keyAt(p.x, p.y, 'white') === 'a1');
    expect(a1).toBeDefined();
    expect(a1!.x).toBeCloseTo(0, 5);
    expect(a1!.y).toBeCloseTo((7 * BOUNDS) / 8, 5);
  });

  it('смена ориентации не меняет расстановку по клеткам', async () => {
    mount('white');
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });
    await flushRender();
    const asWhite = renderedBoardMap(host, 'white');
    board.setOrientation('black');
    await flushRender();
    const asBlack = renderedBoardMap(host, 'black');
    expect(asBlack.size).toBe(asWhite.size);
    for (const [k, v] of asWhite) expect(asBlack.get(k)).toBe(v);
  });
});

describe('координаты', () => {
  it('включаются и выключаются', async () => {
    mount('white');
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });
    await flushRender();
    expect(host.querySelector('coords')).not.toBeNull();
    board.setOptions({ coordinates: false });
    await flushRender();
    expect(host.querySelector('coords')).toBeNull();
    board.setOptions({ coordinates: true });
    await flushRender();
    expect(host.querySelector('coords')).not.toBeNull();
  });
});

/**
 * Регрессия на настоящую причину «фигуры не нажимаются» в упражнениях.
 *
 * Chessground вешает слушатели ввода только внутри redrawAll(), а bindBoard
 * первой строкой делает `if (s.viewOnly) return`. При этом api.set()
 * переворачивает доску ДО применения остального конфига — то есть redrawAll
 * случается, когда viewOnly ещё прежний. Показали ответ (viewOnly) → следующее
 * задание другим цветом → доска выглядит рабочей (viewOnly уже false, dests на
 * месте), но глуха и к мыши, и к тапу.
 */
describe('доска остаётся живой после показа ответа', () => {
  const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

  /**
   * Chessground по умолчанию отвергает недоверенные события (защита от
   * подмены кликов на lichess). В jsdom все события синтетические, поэтому
   * для проверки ввода это ограничение снимаем.
   */
  function trustSyntheticEvents(): void {
    board.api.state.trustAllEvents = true;
  }

  /** Нажатие мышью в центр клетки — как это делает живой пользователь. */
  function pressAt(key: string, orientation: 'white' | 'black'): void {
    const step = BOUNDS / 8;
    const file = key.charCodeAt(0) - 97;
    const rank = Number(key[1]) - 1;
    const col = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 7 - rank : rank;
    const el = host.querySelector('cg-board') as HTMLElement;
    el.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: (col + 0.5) * step,
        clientY: (row + 0.5) * step,
      }),
    );
  }

  function showAnswer(): void {
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'white',
      viewOnly: true,
    });
  }

  function nextTaskAsBlack(): void {
    const pos = posFromFen(BLACK_TO_MOVE);
    board.setPosition({
      fen: BLACK_TO_MOVE,
      orientation: 'black',
      turnColor: 'black',
      movableColor: 'black',
      dests: dests(pos),
      viewOnly: false,
    });
  }

  it('фигура выбирается, когда следующее задание ещё и переворачивает доску', async () => {
    mount('white');
    trustSyntheticEvents();
    showAnswer();
    await flushRender();
    nextTaskAsBlack();
    await flushRender();

    pressAt('e7', 'black');
    expect(board.api.state.viewOnly).toBe(false);
    expect(board.api.state.selected).toBe('e7');
  });

  it('фигура выбирается и без переворота доски', async () => {
    mount('white');
    trustSyntheticEvents();
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'white',
      viewOnly: true,
    });
    await flushRender();
    const pos = posFromFen(INITIAL_FEN);
    board.setPosition({
      fen: INITIAL_FEN,
      orientation: 'white',
      turnColor: 'white',
      movableColor: 'white',
      dests: dests(pos),
      viewOnly: false,
    });
    await flushRender();

    pressAt('e2', 'white');
    expect(board.api.state.selected).toBe('e2');
  });
});
