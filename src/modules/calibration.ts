import type { AppContext, MountFn, Unmount } from '../main';
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
import { applyTheme, BOARD_THEMES, PIECE_SETS, pieceSet } from '../board/theme';
import {
  INITIAL_FEN,
  checkedColor,
  dests,
  fenOf,
  moveFromKeys,
  posFromFen,
  type Chess,
} from '../core/chess';

export interface CalibrationOptions {
  /**
   * Первый запуск: калибровка показывается как короткая первоначальная
   * настройка, а не как обычный раздел. Тексты объясняют, зачем это надо,
   * и внизу появляется кнопка «Готово», уводящая в тренировку.
   */
  firstRun?: boolean;
  onDone?: () => void;
}

export function mountCalibration(root: HTMLElement, ctx: AppContext): Unmount {
  return mountCalibrationView(root, ctx, {});
}

/** Тот же экран, но в роли первоначальной настройки. */
export function firstRunSetup(onDone: () => void): MountFn {
  return (root, ctx) => mountCalibrationView(root, ctx, { firstRun: true, onDone });
}

function mountCalibrationView(
  root: HTMLElement,
  ctx: AppContext,
  opts: CalibrationOptions,
): Unmount {
  const cal: Calibration = { ...ctx.calibration };

  root.append(el('h1', {}, [opts.firstRun ? 'Настройка перед первой тренировкой' : 'Настройки']));
  if (opts.firstRun) {
    root.append(
      el('p', { class: 'setup-lead' }, [
        'Займёт минуту. Эти значения пишутся в каждый замер, поэтому важно ',
        'выставить их один раз до начала — иначе результаты с разных настроек ',
        'смешаются между собой.',
      ]),
    );
  }

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
    onResize: () => showSize(),
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
  const sizeNote = el('p', { class: 'hint' }, ['']);

  /**
   * Настройка задаёт желаемый размер, но на маленьком экране доска
   * ужимается. Показываем оба числа, иначе непонятно, почему ползунок на
   * 480 px, а доска заметно меньше — и какой размер уйдёт в замеры.
   */
  function showSize(): void {
    const capped = board.size < cal.boardSize;
    sizeOut.textContent = `${board.size} px`;
    sizeNote.textContent = capped
      ? `Выбрано ${cal.boardSize} px, но на этом экране помещается ${board.size} px — доска ужата. В замеры пишется фактический размер.`
      : '';
  }

  const sizeInput = el('input', {
    type: 'range',
    min: String(BOARD_SIZE_MIN),
    max: String(BOARD_SIZE_MAX),
    step: '8',
    value: String(cal.boardSize),
  }) as HTMLInputElement;

  /**
   * Верх ползунка — ровно то, что помещается на этом экране, а не общий
   * потолок BOARD_SIZE_MAX. Иначе весь ход выше «влезающего» размера
   * мёртвый: тянешь дальше, а доска упирается в экран и не меняется.
   *
   * Сохранённое значение при этом не трогаем: оно могло прийти с экрана
   * покрупнее и переносится между устройствами. Ползунок просто встаёт на
   * свой потолок, а расхождение объясняет подпись под ним (showSize).
   * Перезапишется оно только если ползунок реально подвинут рукой.
   */
  function syncSizeBounds(): void {
    const fits = Math.min(BOARD_SIZE_MAX, Math.max(BOARD_SIZE_MIN + 8, board.maxFittingSize()));
    sizeInput.max = String(fits);
    if (Number(sizeInput.value) > fits) sizeInput.value = String(fits);
  }

  sizeInput.addEventListener('input', () => {
    cal.boardSize = clampBoardSize(Number(sizeInput.value));
    board.setOptions({ size: cal.boardSize });
    showSize();
    save();
  });
  syncSizeBounds();
  showSize();

  // Место под доску меняется от поворота экрана и появления клавиатуры —
  // потолок ползунка должен ехать следом. onResize доски здесь не хватает:
  // он срабатывает, только когда размер реально поменялся, а потолок
  // зависит ещё и от того, сколько места есть сверх текущего размера.
  const onViewport = () => {
    syncSizeBounds();
    showSize();
  };
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  const firstSync = requestAnimationFrame(onViewport);

  const inputSeg = segmented<InputMode>(
    [
      { value: 'select', label: 'Клик' },
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

  // Оформление применяется ко всему приложению сразу, поэтому доска
  // проверки наверху этой же страницы работает живым предпросмотром.
  const creditEl = el('p', { class: 'hint' }, [pieceSet(cal.pieceSet).credit]);

  const themeSeg = segmented<string>(
    BOARD_THEMES.map((t) => ({ value: t.id, label: t.label })),
    cal.boardTheme,
    (v) => {
      cal.boardTheme = v;
      applyTheme(cal.boardTheme, cal.pieceSet);
      save();
    },
  );

  const pieceSeg = segmented<string>(
    PIECE_SETS.map((p) => ({ value: p.id, label: p.label })),
    cal.pieceSet,
    (v) => {
      cal.pieceSet = v;
      applyTheme(cal.boardTheme, cal.pieceSet);
      creditEl.textContent = pieceSet(v).credit;
      save();
    },
  );

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
    panel('Оформление', [
      el('div', { class: 'row' }, [el('label', {}, ['Доска']), themeSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Фигуры']), pieceSeg.root]),
      creditEl,
    ]),
    panel('Параметры', [
      el('div', { class: 'row' }, [
        el('div', { class: 'col grow' }, [el('label', {}, ['Размер доски']), sizeInput]),
        sizeOut,
      ]),
      sizeNote,
      el('div', { class: 'row' }, [el('label', {}, ['Способ ввода']), inputSeg.root]),
      el('div', { class: 'row' }, [el('label', {}, ['Координаты по краям']), coordsCb]),
      el('div', { class: 'row' }, [el('label', {}, ['Профиль устройства']), profileSeg.root]),
      el('div', { class: 'col' }, [el('label', {}, ['Метка настроек указателя']), pointerInput]),
      el('p', { class: 'hint' }, [
        'Эти значения записываются в каждый замер всех модулей, чтобы результаты разных настроек не смешивались.',
      ]),
    ]),
  );

  if (opts.firstRun) {
    // Настройки сохраняются по ходу правки, так что кнопка только уводит
    // дальше — специально «применять» тут нечего.
    const doneBtn = el('button', { class: 'btn primary setup-done', type: 'button' }, [
      'Готово, к тренировке',
    ]);
    doneBtn.addEventListener('click', () => {
      void ctx.setCalibration({ ...cal }).then(() => opts.onDone?.());
    });
    root.append(doneBtn);
  }

  return () => {
    cancelAnimationFrame(firstSync);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('orientationchange', onViewport);
    board.destroy();
  };
}
