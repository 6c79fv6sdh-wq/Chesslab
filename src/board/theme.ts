/**
 * Оформление доски: цвета полей и набор фигур.
 *
 * Тема применяется не к отдельной доске, а ко всему документу: переменные
 * ложатся на :root, набор фигур — классом на body. Так доска, созданная
 * любым упражнением потом, сразу рисуется в выбранном оформлении, и не
 * приходится протаскивать настройку через каждый модуль.
 */

export interface BoardTheme {
  id: string;
  label: string;
  /** Светлое поле. */
  light: string;
  /** Тёмное поле. */
  dark: string;
  /** Цвет подсветки: точки возможных ходов, выбранная клетка. */
  accent: string;
  /** Подсветка последнего хода — обычно тот же тон, но мягче. */
  lastMove: string;
  /** Цвет подписей координат на светлых и тёмных полях. */
  coordOnLight: string;
  coordOnDark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  {
    id: 'classic',
    label: 'Классическая',
    light: '#f0d9b5',
    dark: '#b58863',
    accent: '20, 85, 30',
    lastMove: 'rgba(155, 199, 0, 0.41)',
    coordOnLight: 'rgba(72, 72, 72, 0.8)',
    coordOnDark: 'rgba(255, 255, 255, 0.8)',
  },
  {
    id: 'graphite',
    label: 'Графит',
    light: '#c8ced3',
    dark: '#2e3d47',
    accent: '46, 170, 110',
    lastMove: 'rgba(70, 200, 140, 0.32)',
    coordOnLight: 'rgba(46, 61, 71, 0.85)',
    coordOnDark: 'rgba(220, 230, 236, 0.85)',
  },
  {
    id: 'blue',
    label: 'Синяя',
    light: '#93a9c9',
    dark: '#1e3a5f',
    accent: '40, 110, 220',
    lastMove: 'rgba(70, 150, 255, 0.34)',
    coordOnLight: 'rgba(24, 44, 72, 0.85)',
    coordOnDark: 'rgba(214, 228, 245, 0.85)',
  },
  {
    id: 'light',
    label: 'Светлая',
    light: '#ffffff',
    dark: '#cdcdcd',
    accent: '200, 60, 60',
    lastMove: 'rgba(224, 90, 90, 0.28)',
    coordOnLight: 'rgba(90, 90, 90, 0.85)',
    coordOnDark: 'rgba(70, 70, 70, 0.85)',
  },
  {
    id: 'sand',
    label: 'Песочная',
    light: '#ece0c8',
    dark: '#a89275',
    accent: '190, 135, 30',
    lastMove: 'rgba(226, 168, 60, 0.38)',
    coordOnLight: 'rgba(90, 76, 52, 0.85)',
    coordOnDark: 'rgba(248, 242, 230, 0.85)',
  },
];

export interface PieceSet {
  id: string;
  label: string;
  /** Автор и лицензия — показываем в настройках, этого требуют лицензии. */
  credit: string;
  /**
   * Папка в public/piece. Пусто у набора, который приходит вместе с
   * Chessground и уже подключён стилями.
   */
  dir: string;
}

export const PIECE_SETS: PieceSet[] = [
  { id: 'cburnett', label: 'Классические', credit: 'Colin M.L. Burnett, GPLv2+', dir: '' },
  { id: 'merida', label: 'Мерида', credit: 'Armando Hernandez Marroquin, GPLv2+', dir: 'merida' },
  { id: 'chessnut', label: 'Чесснат', credit: 'Alexis Luengas, Apache 2.0', dir: 'chessnut' },
  { id: 'spatial', label: 'Объёмные', credit: 'Maurizio Monge, MIT', dir: 'spatial' },
  {
    id: 'glossy',
    label: 'Глянцевые',
    credit: 'по мотивам Maxime Chupin (mpchess), GPLv3+',
    dir: 'glossy',
  },
];

export const DEFAULT_BOARD_THEME = BOARD_THEMES[0].id;
export const DEFAULT_PIECE_SET = PIECE_SETS[0].id;

export function boardTheme(id: string): BoardTheme {
  return BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0];
}

export function pieceSet(id: string): PieceSet {
  return PIECE_SETS.find((p) => p.id === id) ?? PIECE_SETS[0];
}

/** Клетчатый фон одной картинкой: два поля светлых, два тёмных. */
export function boardImage(t: BoardTheme): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2' shape-rendering='crispEdges'>` +
    `<rect x='1' y='0' width='1' height='1' fill='${t.dark}'/>` +
    `<rect x='0' y='1' width='1' height='1' fill='${t.dark}'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/'/g, "'")}")`;
}

const ROLES: Array<[string, string]> = [
  ['pawn', 'P'],
  ['knight', 'N'],
  ['bishop', 'B'],
  ['rook', 'R'],
  ['queen', 'Q'],
  ['king', 'K'],
];

const loadedSets = new Set<string>();

/**
 * Подключить набор фигур. Картинки лежат отдельными файлами и тянутся
 * только для выбранного набора: класть все наборы в бандл — это лишние
 * сотни килобайт на каждое открытие ради того, чем пользуются один раз.
 */
function loadPieceSet(set: PieceSet): void {
  if (!set.dir || loadedSets.has(set.id)) return;
  loadedSets.add(set.id);
  const base = new URL(`piece/${set.dir}/`, document.baseURI).href;
  const rules: string[] = [];
  for (const color of ['white', 'black']) {
    for (const [role, letter] of ROLES) {
      const file = `${color === 'white' ? 'w' : 'b'}${letter}.svg`;
      rules.push(
        `body.pieces-${set.id} .cg-wrap piece.${role}.${color}{background-image:url("${base}${file}")}`,
      );
    }
  }
  const style = document.createElement('style');
  style.id = `piece-set-${set.id}`;
  style.textContent = rules.join('\n');
  document.head.append(style);
}

/** Применить оформление ко всему приложению. */
export function applyTheme(boardThemeId: string, pieceSetId: string): void {
  const t = boardTheme(boardThemeId);
  const s = pieceSet(pieceSetId);

  const root = document.documentElement.style;
  root.setProperty('--sq-light', t.light);
  root.setProperty('--sq-dark', t.dark);
  root.setProperty('--sq-image', boardImage(t));
  root.setProperty('--sq-accent', t.accent);
  root.setProperty('--sq-last-move', t.lastMove);
  root.setProperty('--coord-on-light', t.coordOnLight);
  root.setProperty('--coord-on-dark', t.coordOnDark);

  loadPieceSet(s);
  for (const p of PIECE_SETS) document.body.classList.toggle(`pieces-${p.id}`, p.id === s.id);
}
