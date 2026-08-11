import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Color, Key, Dests } from 'chessground/types';
import { BOARD_HEIGHT_RESERVE, fitBoardSize } from '../core/settings';

import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './board.css';

/**
 * Единственная точка создания доски в приложении.
 *
 * Правила, которые этот модуль охраняет:
 *  - расстановка задается ТОЛЬКО через FEN (`setPosition`), никаких ручных
 *    манипуляций DOM-элементами фигур;
 *  - ориентация всегда передается явно вызывающим модулем, значения
 *    по умолчанию между вкладками не наследуются;
 *  - фигуры — cburnett SVG из ресурсов Chessground (подключены выше).
 */

export type InputMode = 'select' | 'drag' | 'both';

/**
 * Высота окна, не дёргающаяся от адресной строки Safari.
 *
 * `documentElement.clientHeight` на iOS меняется, когда адресная строка
 * сворачивается при прокрутке, — доска на такой высоте пересчитывалась бы
 * прямо посреди упражнения. `100svh` (small viewport height) — это высота
 * при РАЗВЁРНУТОЙ адресной строке, она постоянна и меняется только от
 * поворота экрана. Меряем её скрытым зондом, одним на все доски.
 */
let svhProbe: HTMLElement | null = null;
let svhUnsupported = false;

function viewportHeight(): number {
  const fallback = document.documentElement.clientHeight;
  if (svhUnsupported) return fallback;
  if (!svhProbe) {
    if (typeof CSS === 'undefined' || !CSS.supports?.('height', '100svh')) {
      svhUnsupported = true;
      return fallback;
    }
    svhProbe = document.createElement('div');
    svhProbe.setAttribute('aria-hidden', 'true');
    svhProbe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:100svh;pointer-events:none;visibility:hidden';
    document.body.append(svhProbe);
  }
  return svhProbe.offsetHeight || fallback;
}

export interface BoardOptions {
  /** Ориентация: снизу этот цвет. Обязателен, умолчания нет. */
  orientation: Color;
  /** Желаемый размер доски в пикселях. На узком экране будет урезан. */
  size: number;
  /** Показывать координаты по краям. */
  coordinates: boolean;
  /** Способ ввода хода. */
  inputMode: InputMode;
  /** Разрешить premove. */
  premovable?: boolean;
  /** Анимация перестановки фигур. В тестах выключается. */
  animation?: boolean;
  /** Только просмотр, ходы не принимаются. */
  viewOnly?: boolean;
  onMove?: (orig: Key, dest: Key) => void;
  onSelect?: (key: Key) => void;
  onSetPremove?: (orig: Key, dest: Key) => void;
  onUnsetPremove?: () => void;
  /** Фактический размер изменился: экран повернули или доска не влезла. */
  onResize?: (size: number) => void;
}

export interface PositionOptions {
  fen: string;
  orientation: Color;
  /** Чей ход. Определяет, какие фигуры вообще можно брать. */
  turnColor: Color;
  /** Каким цветом ходит пользователь; undefined — ходить нельзя. */
  movableColor?: Color | undefined;
  dests?: Dests;
  lastMove?: Key[] | undefined;
  /** Цвет стороны под шахом (Chessground сам найдёт короля), либо false. */
  check?: Color | boolean | undefined;
  selected?: Key | undefined;
  viewOnly?: boolean;
}

export class Board {
  readonly api: Api;
  readonly wrap: HTMLElement;
  private opts: BoardOptions;
  private unbindGuards: Array<() => void> = [];
  private readonly host: HTMLElement;
  private rendered: number;
  private ro: ResizeObserver | null = null;
  private observed: Element | null = null;
  private firstFit = 0;
  private destroyed = false;

  constructor(container: HTMLElement, opts: BoardOptions) {
    this.opts = opts;
    this.host = container;
    container.innerHTML = '';
    this.wrap = document.createElement('div');
    this.wrap.className = 'hl-board';
    container.appendChild(this.wrap);
    this.rendered = fitBoardSize(opts.size, this.availWidth(), this.availHeight());
    this.applySize(this.rendered);

    this.api = Chessground(this.wrap, this.baseConfig());
    this.installGuards();
    this.watchViewport();
  }

  /** Фактический размер доски: он же уходит в замеры, а не желаемый. */
  get size(): number {
    return this.rendered;
  }

  private baseConfig(): Config {
    const o = this.opts;
    return {
      orientation: o.orientation,
      coordinates: o.coordinates,
      viewOnly: !!o.viewOnly,
      disableContextMenu: true,
      blockTouchScroll: true,
      addDimensionsCssVarsTo: this.wrap,
      animation: { enabled: o.animation !== false, duration: 120 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        color: undefined,
        showDests: true,
        rookCastle: true,
        events: {
          after: (orig, dest) => this.opts.onMove?.(orig, dest),
        },
      },
      premovable: {
        enabled: !!o.premovable,
        showDests: true,
        events: {
          set: (orig, dest) => this.opts.onSetPremove?.(orig, dest),
          unset: () => this.opts.onUnsetPremove?.(),
        },
      },
      draggable: {
        enabled: o.inputMode !== 'select',
        distance: 3,
        autoDistance: false,
        showGhost: true,
        deleteOnDropOff: false,
      },
      selectable: { enabled: o.inputMode !== 'drag' },
      drawable: { enabled: false },
      events: {
        select: (key) => this.opts.onSelect?.(key),
      },
    };
  }

  /**
   * Сеть безопасности для перетаскивания: Chessground сам слушает mouseup
   * на document, но отпускание кнопки за пределами окна (или отмена
   * жеста системой) события не даст. Тогда фигура зависла бы «в руке».
   */
  private installGuards(): void {
    const release = () => {
      const st = this.api.state;
      if (st.draggable.current) this.api.cancelMove();
    };
    const onCancel = () => release();
    const onBlur = () => release();
    document.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    this.unbindGuards.push(() => document.removeEventListener('pointercancel', onCancel));
    this.unbindGuards.push(() => window.removeEventListener('blur', onBlur));
  }

  private applySize(size: number): void {
    this.wrap.style.width = `${size}px`;
    this.wrap.style.height = `${size}px`;
  }

  /**
   * Доступная ширина — по родителю контейнера. Сам контейнер (.board-host)
   * inline-block и ужимается по доске, то есть о свободном месте не знает:
   * спросив его, мы бы всегда получали текущий размер доски и никогда её
   * не уменьшили. Родитель (.board-area) — блочный, его ширина и есть
   * то, во что надо влезть.
   *
   * Ноль означает «померить нечем»: модули собирают разметку до
   * root.append, и на момент конструктора доска ещё не в документе.
   * Тогда рисуем желаемый размер, а первый настоящий замер делает
   * watchViewport() следующим кадром.
   */
  private availWidth(): number {
    const box = this.host.parentElement;
    return box ? box.clientWidth : 0;
  }

  /**
   * Доступная высота — экран минус запас под липкие вкладки. Меряем окно,
   * а не какой-либо блок страницы: высота блока сама зависит от высоты
   * доски, и получилась бы обратная связь «доска ужалась → блок стал ниже
   * → доска ужалась ещё».
   */
  private availHeight(): number {
    const h = viewportHeight();
    return h > 0 ? h - BOARD_HEIGHT_RESERVE : 0;
  }

  /**
   * Место под доску меняется от поворота экрана, появления клавиатуры и просто
   * другого устройства. ResizeObserver ловит это точнее, чем window.resize
   * (на iOS resize по повороту приходит до перекладки layout), но слушаем
   * оба: ResizeObserver может отсутствовать в старых webview.
   */
  private watchViewport(): void {
    this.firstFit = requestAnimationFrame(() => {
      this.firstFit = 0;
      this.refit();
    });
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.refit());
    }
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onViewportChange);
  }

  private onViewportChange = (): void => {
    this.refit();
  };

  /** Пересчитать фактический размер под текущую ширину экрана. */
  private refit(): void {
    if (this.destroyed) return;

    const box = this.host.parentElement;
    if (box && this.ro && this.observed !== box) {
      if (this.observed) this.ro.unobserve(this.observed);
      this.ro.observe(box);
      this.observed = box;
    }

    const next = fitBoardSize(this.opts.size, this.availWidth(), this.availHeight());
    if (next === this.rendered) return;
    this.rendered = next;
    this.applySize(next);
    // Chessground кеширует размеры доски: без redrawAll фигуры остались бы
    // разложены по старой сетке.
    this.api.redrawAll();
    this.opts.onResize?.(next);
  }

  /** Единственный способ выставить фигуры: из FEN. */
  setPosition(p: PositionOptions): void {
    const cfg: Config = {
      fen: p.fen,
      orientation: p.orientation,
      turnColor: p.turnColor,
      lastMove: p.lastMove,
      check: p.check ?? false,
      selected: p.selected,
      viewOnly: p.viewOnly ?? !!this.opts.viewOnly,
      movable: {
        free: false,
        color: p.movableColor,
        dests: p.dests ?? new Map(),
        showDests: true,
      },
    };
    this.api.set(cfg);
  }

  setDests(dests: Dests, movableColor: Color | undefined): void {
    this.api.set({ movable: { free: false, color: movableColor, dests, showDests: true } });
  }

  setOptions(patch: Partial<BoardOptions>): void {
    const coordsChanged = patch.coordinates !== undefined && patch.coordinates !== this.opts.coordinates;
    this.opts = { ...this.opts, ...patch };
    this.api.set({
      coordinates: this.opts.coordinates,
      orientation: this.opts.orientation,
      animation: { enabled: this.opts.animation !== false },
      draggable: { enabled: this.opts.inputMode !== 'select' },
      selectable: { enabled: this.opts.inputMode !== 'drag' },
      premovable: { enabled: !!this.opts.premovable },
    });
    // Координаты живут в обёртке, созданной при инициализации: чтобы их
    // добавить или убрать, обёртку надо перерисовать целиком.
    if (coordsChanged) this.api.redrawAll();
    // Желаемый размер сменился — refit() сам решит, сколько влезет,
    // и перерисует доску, если фактический размер изменился.
    if (patch.size !== undefined) this.refit();
  }

  setOrientation(color: Color): void {
    this.opts.orientation = color;
    this.api.set({ orientation: color });
  }

  playPremove(): boolean {
    return this.api.playPremove();
  }

  cancelPremove(): void {
    this.api.cancelPremove();
  }

  hasPremove(): boolean {
    return !!this.api.state.premovable.current;
  }

  /** Скрыть фигуры, оставив доску (для упражнений с экспозицией). */
  setPiecesHidden(hidden: boolean): void {
    this.wrap.classList.toggle('pieces-hidden', hidden);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.firstFit) cancelAnimationFrame(this.firstFit);
    this.ro?.disconnect();
    this.ro = null;
    this.observed = null;
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    this.unbindGuards.forEach((f) => f());
    this.unbindGuards = [];
    this.api.destroy();
    this.wrap.remove();
  }
}
