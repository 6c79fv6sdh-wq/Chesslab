import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Board } from '../src/board/board';
import { INITIAL_FEN } from '../src/core/chess';

/**
 * Доска обязана быть на экране целиком.
 *
 * Иначе на планшете упражнение начинается с доски, наполовину ушедшей под
 * нижний край: над ней шапка, липкие вкладки и карточка настроек. А доска
 * всегда развёрнута к игроку, то есть свои фигуры стоят на нижних
 * горизонталях — ровно в отрезанной части. Выглядит это как «фигуры не
 * нажимаются»: тап по ним просто не доходит до страницы.
 */

const VIEWPORT = 800;

let board: Board | null = null;
let scrollBy: ReturnType<typeof vi.fn>;
let rects: Map<Element, Partial<DOMRect>>;

/** Прямоугольники задаём поэлементно: в jsdom layout не считается. */
function rectOf(el: Element): DOMRect {
  const r = rects.get(el) ?? {};
  const top = r.top ?? 0;
  const height = r.height ?? 0;
  const width = r.width ?? 0;
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  rects = new Map();
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return rectOf(this);
  };
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: VIEWPORT,
    configurable: true,
  });
  scrollBy = vi.fn();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
});

afterEach(() => {
  board?.destroy();
  board = null;
  document.body.innerHTML = '';
});

/** Липкая полоса вкладок высотой 60 — как на планшете. */
function addStickyTabs(height = 60): void {
  const tabs = document.createElement('div');
  tabs.id = 'tabs';
  tabs.style.position = 'sticky';
  document.body.append(tabs);
  rects.set(tabs, { top: 0, height, width: 1000 });
}

function mountAt(top: number, size = 480): Board {
  const area = document.createElement('div');
  Object.defineProperty(area, 'clientWidth', { value: 1000, configurable: true });
  const host = document.createElement('div');
  area.append(host);
  document.body.append(area);
  const made = new Board(host, {
    orientation: 'white',
    size,
    coordinates: false,
    inputMode: 'both',
    animation: false,
  });
  // Доска встала там, куда её положила разметка страницы.
  rects.set(made.wrap, { top, height: made.size, width: made.size });
  return made;
}

describe('доска не уезжает за нижний край экрана', () => {
  it('страница прокручивается, когда доска не помещается целиком', () => {
    addStickyTabs(60);
    // Над доской шапка, вкладки и карточка настроек: верх на 440,
    // низ на 920 — при экране в 800 нижние две горизонтали отрезаны.
    board = mountAt(440);
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });

    expect(scrollBy).toHaveBeenCalled();
    const arg = scrollBy.mock.calls.at(-1)![0] as ScrollToOptions;
    // Доска встаёт сразу под вкладками, а не куда попало.
    expect(arg.top).toBeGreaterThan(0);
    expect(440 - arg.top!).toBeGreaterThanOrEqual(60);
    expect(440 - arg.top!).toBeLessThanOrEqual(60 + 12);
  });

  it('видимую доску никто не дёргает', () => {
    addStickyTabs(60);
    board = mountAt(80);
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('доска, уехавшая вверх, тоже возвращается', () => {
    addStickyTabs(60);
    board = mountAt(-200);
    board.setPosition({ fen: INITIAL_FEN, orientation: 'white', turnColor: 'white' });
    expect(scrollBy).toHaveBeenCalled();
    expect((scrollBy.mock.calls.at(-1)![0] as ScrollToOptions).top).toBeLessThan(0);
  });

  /**
   * На телефоне вкладки переносятся на три строки, и полоса становится
   * втрое выше. Фиксированный запас высоты этого не знал, и доска
   * рассчитывалась на место, которого нет.
   */
  it('высокая полоса вкладок уменьшает доску', () => {
    addStickyTabs(180);
    board = mountAt(200, 760);
    expect(board.maxFittingSize()).toBeLessThanOrEqual(VIEWPORT - 180);
  });

  it('без липкой полосы работает прежний запас', () => {
    board = mountAt(200, 760);
    expect(board.maxFittingSize()).toBeGreaterThan(VIEWPORT - 180);
  });
});
