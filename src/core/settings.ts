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
