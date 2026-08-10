import './styles.css';
import { loadCalibration, requestPersistentStorage, saveCalibration } from './core/db';
import { DEFAULT_CALIBRATION, type Calibration } from './core/settings';
import { el } from './core/ui';
import { hasAccess, mountGate } from './gate';

import { mountCalibration } from './modules/calibration';
import { mountMotorics } from './modules/motorics';
import { mountPremove } from './modules/premove';
import { mountReaction } from './modules/reaction';
import { mountOpenings } from './modules/openings';
import { mountScramble } from './modules/scramble';
import { mountData } from './modules/data';

export interface AppContext {
  calibration: Calibration;
  setCalibration(c: Calibration): Promise<void>;
}

export type Unmount = () => void;
export type MountFn = (root: HTMLElement, ctx: AppContext) => Unmount;

interface Tab {
  id: string;
  label: string;
  mount: MountFn;
}

const TABS: Tab[] = [
  { id: 'calibration', label: 'Калибровка', mount: mountCalibration },
  { id: 'motorics', label: 'Моторика', mount: mountMotorics },
  { id: 'premove', label: 'Premove', mount: mountPremove },
  { id: 'reaction', label: 'Реакция', mount: mountReaction },
  { id: 'openings', label: 'Дебюты', mount: mountOpenings },
  { id: 'scramble', label: 'Скрэмбл', mount: mountScramble },
  { id: 'data', label: 'Данные', mount: mountData },
];

/**
 * Перезагружаем страницу, когда новый service worker берёт управление:
 * иначе на экране остаётся старый код, а пользователь думает, что
 * исправление не приехало.
 */
function reloadOnServiceWorkerUpdate(): void {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

async function boot(): Promise<void> {
  const nav = document.getElementById('tabs') as HTMLElement;
  const view = document.getElementById('view') as HTMLElement;

  const buildEl = document.getElementById('build-id');
  if (buildEl) buildEl.textContent = `сборка ${__BUILD_ID__}`;

  // Просим постоянное хранение до первых замеров, чтобы браузер
  // не вычистил базу через неделю простоя.
  void requestPersistentStorage();

  let calibration: Calibration = { ...DEFAULT_CALIBRATION };
  try {
    calibration = await loadCalibration();
  } catch (e) {
    console.warn('Настройки не загрузились, беру значения по умолчанию', e);
  }

  const ctx: AppContext = {
    calibration,
    async setCalibration(c: Calibration) {
      ctx.calibration = c;
      calibration = c;
      await saveCalibration(c);
    },
  };

  let unmount: Unmount | null = null;
  const buttons = new Map<string, HTMLButtonElement>();

  const show = (id: string) => {
    const tab = TABS.find((t) => t.id === id) ?? TABS[0];
    if (unmount) {
      unmount();
      unmount = null;
    }
    view.innerHTML = '';
    for (const [k, b] of buttons) b.classList.toggle('active', k === tab.id);
    location.hash = `#${tab.id}`;
    unmount = tab.mount(view, ctx);
  };

  for (const t of TABS) {
    const b = el('button', { class: 'tab', type: 'button' }, [t.label]);
    b.addEventListener('click', () => show(t.id));
    buttons.set(t.id, b);
    nav.append(b);
  }

  window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '');
    if (id && TABS.some((t) => t.id === id) && !buttons.get(id)?.classList.contains('active')) show(id);
  });

  // Отключаем двойной тап с зумом и резиновую прокрутку на доске.
  document.addEventListener(
    'gesturestart',
    (e) => {
      e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.hl-board')) e.preventDefault();
    },
    { passive: false },
  );
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 320) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );

  const initial = location.hash.replace('#', '');
  show(TABS.some((t) => t.id === initial) ? initial : 'calibration');
}

// Слушаем обновление service worker'а СРАЗУ: пока показана витрина Lab,
// страница работает на старом закешированном JS (там же старый
// ACCESS_CODE). Без этого вернувшийся пользователь с устаревшим SW
// застрял бы, вводя новый код в старый бандл, который его не узнаёт.
reloadOnServiceWorkerUpdate();

// Без доступа boot() вообще не вызывается: вкладки не монтируются,
// IndexedDB не читается. Вместо них в #view — публичная витрина (gate.ts):
// скриншоты режимов и два сценария входа. boot() запускается только после
// верного кода в диалоге «Войти в Lab».
if (hasAccess()) {
  void boot();
} else {
  mountGate(() => void boot());
}
