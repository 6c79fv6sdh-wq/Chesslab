import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Color, Key, Dests } from 'chessground/types';

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

export interface BoardOptions {
  /** Ориентация: снизу этот цвет. Обязателен, умолчания нет. */
  orientation: Color;
  /** Размер доски в пикселях. */
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

  constructor(container: HTMLElement, opts: BoardOptions) {
    this.opts = opts;
    container.innerHTML = '';
    this.wrap = document.createElement('div');
    this.wrap.className = 'hl-board';
    container.appendChild(this.wrap);
    this.applySize(opts.size);

    this.api = Chessground(this.wrap, this.baseConfig());
    this.installGuards();
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
    if (patch.size !== undefined) this.applySize(patch.size);
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
    if (coordsChanged || patch.size !== undefined) this.api.redrawAll();
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
    this.unbindGuards.forEach((f) => f());
    this.unbindGuards = [];
    this.api.destroy();
    this.wrap.remove();
  }
}
