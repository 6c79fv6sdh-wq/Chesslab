import type { InputMode } from '../board/board';

export type DeviceProfile = 'ipad-mouse' | 'ipad-finger' | 'pc-mouse';

export const DEVICE_PROFILE_LABELS: Record<DeviceProfile, string> = {
  'ipad-mouse': 'iPad + мышь',
  'ipad-finger': 'iPad палец',
  'pc-mouse': 'ПК + мышь',
};

export interface Calibration {
  boardSize: number;
  inputMode: InputMode;
  coordinates: boolean;
  deviceProfile: DeviceProfile;
  /** Свободная метка настроек указателя, например «DPI 1600, скорость 5». */
  pointerLabel: string;
}

export const BOARD_SIZE_MIN = 320;
export const BOARD_SIZE_MAX = 760;

export const DEFAULT_CALIBRATION: Calibration = {
  boardSize: 480,
  inputMode: 'both',
  coordinates: true,
  deviceProfile: 'ipad-mouse',
  pointerLabel: '',
};

export function clampBoardSize(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_CALIBRATION.boardSize;
  return Math.min(BOARD_SIZE_MAX, Math.max(BOARD_SIZE_MIN, Math.round(v)));
}

/** Доска всегда кратна 8: тогда клетка — целое число пикселей, без щелей. */
const SQUARE_STEP = 8;

/**
 * Нижняя граница на совсем узких экранах. Меньше BOARD_SIZE_MIN намеренно:
 * настройка задаёт желаемый размер, а физическую ширину телефона не
 * переспорить — лучше доска 264 px целиком, чем 320 px с обрезанной
 * вертикалью h.
 */
export const BOARD_SIZE_FLOOR = 160;

/**
 * Сколько высоты экрана доске не отдаём: липкая полоса вкладок сверху плюс
 * немного воздуха. Без этого запаса доска ростом ровно в экран уезжала бы
 * верхом под вкладки.
 */
export const BOARD_HEIGHT_RESERVE = 72;

/**
 * Сколько на самом деле рисуем в доступном месте.
 *
 * `boardSize` в калибровке — это ЖЕЛАЕМЫЙ размер: его выбирают на большом
 * экране, он переносится между устройствами и пишется в замеры. Реальный
 * размер — минимум из желаемого, доступной ширины и доступной высоты.
 * Высота важна не меньше ширины: телефон в альбомной ориентации высотой
 * 390 px не покажет доску 480 px целиком, сколько бы ширины ни было.
 *
 * Ноль или отрицательное значение любого из ограничений означает «померить
 * не удалось» (элемент ещё не в документе) — такое ограничение просто не
 * учитывается.
 */
export function fitBoardSize(desired: number, availWidth: number, availHeight = 0): number {
  const want = clampBoardSize(desired);
  const limits = [availWidth, availHeight].filter((v) => Number.isFinite(v) && v > 0);
  if (!limits.length) return want;
  const fits = Math.floor(Math.min(...limits) / SQUARE_STEP) * SQUARE_STEP;
  return Math.max(BOARD_SIZE_FLOOR, Math.min(want, fits));
}

export function normalizeCalibration(raw: unknown): Calibration {
  const c = (raw ?? {}) as Partial<Calibration>;
  const inputMode: InputMode =
    c.inputMode === 'select' || c.inputMode === 'drag' || c.inputMode === 'both'
      ? c.inputMode
      : DEFAULT_CALIBRATION.inputMode;
  const deviceProfile: DeviceProfile =
    c.deviceProfile === 'ipad-mouse' || c.deviceProfile === 'ipad-finger' || c.deviceProfile === 'pc-mouse'
      ? c.deviceProfile
      : DEFAULT_CALIBRATION.deviceProfile;
  return {
    boardSize: clampBoardSize(Number(c.boardSize ?? DEFAULT_CALIBRATION.boardSize)),
    inputMode,
    coordinates: typeof c.coordinates === 'boolean' ? c.coordinates : DEFAULT_CALIBRATION.coordinates,
    deviceProfile,
    pointerLabel: typeof c.pointerLabel === 'string' ? c.pointerLabel : '',
  };
}
