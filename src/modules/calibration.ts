import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import type { InputMode } from '../board/board';
import {
  BOARD_SIZE_MAX,
  BOARD_SIZE_MIN,
  DEVICE_PROFILE_LABELS,
  type Calibration,
  type DeviceProfile,
  clampBoardSize,
} from '../core/settings';
import { el, panel, segmented } from '../core/ui';
import {
  INITIAL_FEN,
  checkedColor,
  dests,
  fenOf,
  moveFromKeys,
  posFromFen,
  type Chess,
} from '../core/chess';

export function mountCalibration(root: HTMLElement, ctx: AppContext): Unmount {
  const cal: Calibration = { ...ctx.calibration };

  root.append(el('h1', {}, ['Калибровка']));

  const boardHost = el('div', { class: 'board-host' });
  let pos: Chess = posFromFen(INITIAL_FEN);

  const board = new Board(boardHost, {
    orientation: 'white',
    size: cal.boardSize,
    coordinates: cal.coordinates,
    inputMode: cal.inputMode,
    onMove: (orig, dest) => {
      const mv = moveFromKeys(pos, orig, dest);
      if (mv) pos.play(mv);
      paint();
    },
  });

  // Стартовая позиция для проверки ощущений от ввода. Ходы легальные,
  // но никуда не записываются.
  function paint(): void {
    board.setPosition({
      fen: fenOf(pos),
      orientation: 'white',
      turnColor: pos.turn,
      movableColor: pos.turn,
      dests: dests(pos),
      check: checkedColor(pos),
    });
  }
  paint();

  const save = () => {
    void ctx.setCalibration({ ...cal });
  };

  const sizeOut = el('span', { class: 'stat-v' }, [`${cal.boardSize} px`]);
  const sizeInput = el('input', {
    type: 'range',
    min: String(BOARD_SIZE_MIN),
    max: String(BOARD_SIZE_MAX),
    step: '8',
    value: String(cal.boardSize),
  }) as HTMLInputElement;
  sizeInput.addEventListener('input', () => {
    cal.boardSize = clampBoardSize(Number(sizeInput.value));
    sizeOut.textContent = `${cal.boardSize} px`;
    board.setOptions({ size: cal.boardSize });
    save();
  });

  const inputSeg = segmented<InputMode>(
    [
      { value: 'select', label: 'Клик-клик' },
      { value: 'drag', label: 'Перетаскивание' },
      { value: 'both', label: 'Оба' },
    ],
    cal.inputMode,
    (v) => {
      cal.inputMode = v;
      board.setOptions({ inputMode: v });
      save();
    },
  );

  const coordsCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  coordsCb.checked = cal.coordinates;
  coordsCb.addEventListener('change', () => {
    cal.coordinates = coordsCb.checked;
    board.setOptions({ coordinates: cal.coordinates });
    save();
  });

  const profileSeg = segmented<DeviceProfile>(
    (Object.keys(DEVICE_PROFILE_LABELS) as DeviceProfile[]).map((k) => ({
      value: k,
      label: DEVICE_PROFILE_LABELS[k],
    })),
    cal.deviceProfile,
    (v) => {
      cal.deviceProfile = v;
      save();
    },
  );

  const pointerInput = el('input', {
    type: 'text',
    placeholder: 'например: DPI 1600, скорость 5/10, ускорение выкл',
  }) as HTMLInputElement;
  pointerInput.value = cal.pointerLabel;
  pointerInput.addEventListener('input', () => {
    cal.pointerLabel = pointerInput.value;
    save();
  });

  const resetBtn = el('button', { class: 'btn', type: 'button' }, ['Сбросить позицию']);
  resetBtn.addEventListener('click', () => {
    pos = posFromFen(INITIAL_FEN);
    paint();
  });

  root.append(
    panel('Проверка доски', [
      el('div', { class: 'board-area' }, [boardHost]),
      el('p', { class: 'hint' }, [
        'Доска здесь только для проверки ощущений от ввода, ходы не записываются.',
      ]),
      resetBtn,
    ]),
    panel('Параметры', [
      el('div', { class: 'row' }, [
        el('div', { class: 'col grow' }, [el('label', {}, ['Размер доски']), sizeInput]),
        sizeOut,
      ]),
      el('div', { class: 'row' }, [el('label', {}, ['Способ ввода']), inputSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Координаты по краям']), coordsCb]),
      el('div', { class: 'row' }, [el('label', {}, ['Профиль устройства']), profileSeg.root]),
      el('div', { class: 'col' }, [el('label', {}, ['Метка настроек указателя']), pointerInput]),
      el('p', { class: 'hint' }, [
        'Эти значения записываются в каждый замер всех модулей, чтобы результаты разных настроек не смешивались.',
      ]),
    ]),
  );

  return () => board.destroy();
}
