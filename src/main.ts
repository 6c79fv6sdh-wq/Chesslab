import './styles.css';
import {
  hasSavedCalibration,
  loadCalibration,
  requestPersistentStorage,
  saveCalibration,
} from './core/db';
import { DEFAULT_CALIBRATION, type Calibration } from './core/settings';
import { el } from './core/ui';
import { consumeLoginFromHash, isLoginInFlight } from './core/access';
import { watchForUpdate } from './core/update';
import { hasAccess, mountGate } from './gate';

import { applyTheme } from './board/theme';
import type { Profile } from './core/profiles';
import {
  currentProfile,
  mountProfileGate,
  renameProfile,
  signOut as signOutProfile,
} from './modules/profile-gate';
import { firstRunSetup, mountCalibration } from './modules/calibration';
import { mountGames } from './modules/games';
import { mountToday } from './modules/today';
import { mountMotorics } from './modules/motorics';
import { mountPremove } from './modules/premove';
import { mountReaction } from './modules/reaction';
import { mountOpenings } from './modules/openings';
import { mountScramble } from './modules/scramble';
import { mountData } from './modules/data';

export interface AppContext {
  calibration: Calibration;
  setCalibration(c: Calibration): Promise<void>;
  /** Кто сейчас занимается. Все замеры и партии пишутся на него. */
  profile: Profile;
  /** Сменить имя своего профиля (переименование, не переключение). */
  setProfileName(name: string): Promise<void>;
  /** Выйти к экрану ввода имени. */
  signOut(): Promise<void>;
}

export type Unmount = () => void;
export type MountFn = (root: HTMLElement, ctx: AppContext) => Unmount;

interface Tab {
  id: string;
  label: string;
  mount: MountFn;
}

/**
 * Двухуровневая навигация.
 *
 * Верхний уровень — путь ученика от занятий к накопленному прогрессу:
 * Тренировки → Спарринг → Мои партии → Прогресс. «Тренировки» — не
 * экран, а раскрывающаяся группа: у неё нет своего mount, кликом по ней
 * попадают на первый пункт группы (today), а сам раздел показывает
 * второй ряд вкладок ниже. Собственный id группы ('training') в
 * location.hash никогда не попадает — это только ключ для подсветки
 * кнопки, маршруты остаются плоскими и прежними.
 *
 * Калибровки в обоих рядах нет намеренно — это настройка, а не занятие,
 * и живёт она компактной иконкой справа (SETTINGS_TAB), чтобы не
 * отвлекать на себя внимание каждый заход.
 */
const TRAINING_TABS: Tab[] = [
  { id: 'today', label: 'Сегодня', mount: mountToday },
  { id: 'motorics', label: 'Моторика', mount: mountMotorics },
  { id: 'premove', label: 'Премувы', mount: mountPremove },
  { id: 'reaction', label: 'Тактика', mount: mountReaction },
  { id: 'openings', label: 'Дебюты', mount: mountOpenings },
];

const TRAINING_GROUP_ID = 'training';
const TRAINING_IDS = new Set(TRAINING_TABS.map((t) => t.id));

// «Спарринг» — партия с ботом на флажке, прежнее название «Цейтнот».
// Переименование когда-то сделали только тут, в подписи вкладки: сама
// страница внутри (h1, план дня, витрина) ещё долго называлась
// «Цейтнот» — с новой подписью вкладки над ней это читалось как два
// разных названия одного и того же. Теперь везде «Спарринг»; id и
// маршрут (#scramble) не трогаем — на него ссылаются история партий и
// разбор.
const SCRAMBLE_TAB: Tab = { id: 'scramble', label: 'Спарринг', mount: mountScramble };
const GAMES_TAB: Tab = { id: 'games', label: 'Мои партии', mount: mountGames };
// id 'data' сохраняем: по нему уже есть закладки и ссылки в хеше.
const DATA_TAB: Tab = { id: 'data', label: 'Прогресс', mount: mountData };
const SETTINGS_TAB: Tab = { id: 'calibration', label: 'Настройки', mount: mountCalibration };

const ALL_TABS: Tab[] = [...TRAINING_TABS, SCRAMBLE_TAB, GAMES_TAB, DATA_TAB, SETTINGS_TAB];

/** Пункты верхнего ряда: группа «Тренировки» + три самостоятельных экрана. */
const TOP_ENTRIES: Array<{ id: string; label: string; group: boolean }> = [
  { id: TRAINING_GROUP_ID, label: 'Тренировки', group: true },
  { id: SCRAMBLE_TAB.id, label: SCRAMBLE_TAB.label, group: false },
  { id: GAMES_TAB.id, label: GAMES_TAB.label, group: false },
  { id: DATA_TAB.id, label: DATA_TAB.label, group: false },
];

const SETTINGS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/>' +
  '<circle cx="15" cy="7" r="2.2"/><line x1="4" y1="12" x2="20" y2="12"/>' +
  '<circle cx="9" cy="12" r="2.2"/><line x1="4" y1="17" x2="20" y2="17"/>' +
  '<circle cx="13.5" cy="17" r="2.2"/></svg>';

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
    // Но НЕ посреди проверки кода: перезагрузка обрывает запрос к воркеру,
    // и вход падает с «не получилось проверить код» на ровном месте —
    // причём тем вернее, чем свежее выкачена версия. В этом случае просто
    // не перезагружаемся: новая версия подхватится при следующем заходе.
    if (isLoginInFlight()) return;
    reloading = true;
    location.reload();
  });
}

async function boot(): Promise<void> {
  // #tabs остаётся общей липкой оболочкой на всю навигацию (её высоту
  // считает stickyTop() в board.ts — id намеренно не трогаем), а два ряда
  // кнопок живут внутри как отдельные контейнеры.
  const nav = document.getElementById('tabs') as HTMLElement;
  const primaryRow = document.getElementById('tabs-primary') as HTMLElement;
  const secondaryRow = document.getElementById('tabs-secondary') as HTMLElement;
  const view = document.getElementById('view') as HTMLElement;

  // Просим постоянное хранение до первых замеров, чтобы браузер
  // не вычистил базу через неделю простоя.
  void requestPersistentStorage();

  // Кто занимается. Без профиля дальше не идём: к нему привязаны и
  // замеры, и партии, а на планшете за приложением сидят по очереди.
  let profile = await currentProfile();
  if (!profile) {
    nav.classList.add('setup-mode');
    await new Promise<void>((resolve) => {
      mountProfileGate(view, (p) => {
        profile = p;
        resolve();
      });
    });
    nav.classList.remove('setup-mode');
  }
  const signedIn = profile as Profile;

  let calibration: Calibration = { ...DEFAULT_CALIBRATION };
  try {
    calibration = await loadCalibration();
  } catch (e) {
    console.warn('Настройки не загрузились, беру значения по умолчанию', e);
  }

  // Оформление — первым делом, до монтирования вкладок: иначе доска
  // мигнёт классической темой и только потом перекрасится.
  applyTheme(calibration.boardTheme, calibration.pieceSet);

  const ctx: AppContext = {
    calibration,
    profile: signedIn,
    async setCalibration(c: Calibration) {
      ctx.calibration = c;
      calibration = c;
      applyTheme(c.boardTheme, c.pieceSet);
      await saveCalibration(c);
    },
    async setProfileName(name: string) {
      ctx.profile = await renameProfile(ctx.profile, name);
    },
    async signOut() {
      await signOutProfile();
      location.reload();
    },
  };

  let unmount: Unmount | null = null;
  let activeId: string | null = null;

  const topButtons = new Map<string, HTMLButtonElement>();
  const subButtons = new Map<string, HTMLButtonElement>();

  /**
   * Подсветка обоих рядов разом. У группы «Тренировки» своей вкладки нет —
   * она активна, когда активен любой из её подпунктов, — а второй ряд
   * вообще показываем только тогда: снаружи «Тренировок» он не нужен.
   */
  const updateNavState = (id: string | null) => {
    const inTraining = id !== null && TRAINING_IDS.has(id);
    for (const [k, b] of topButtons) b.classList.toggle('active', k === TRAINING_GROUP_ID ? inTraining : k === id);
    for (const [k, b] of subButtons) b.classList.toggle('active', k === id);
    secondaryRow.classList.toggle('visible', inTraining);
    settingsBtn.classList.toggle('active', id === SETTINGS_TAB.id);
  };

  /** Смонтировать произвольный экран, не обязательно из полосы вкладок. */
  const mountView = (mount: MountFn, id: string | null) => {
    if (unmount) {
      unmount();
      unmount = null;
    }
    view.innerHTML = '';
    activeId = id;
    updateNavState(id);
    window.scrollTo({ top: 0 });
    unmount = mount(view, ctx);
  };

  const show = (id: string) => {
    const tab = ALL_TABS.find((t) => t.id === id) ?? TRAINING_TABS[0];
    location.hash = `#${tab.id}`;
    mountView(tab.mount, tab.id);
  };

  for (const entry of TOP_ENTRIES) {
    const b = el('button', { class: 'tab-primary', type: 'button' }, [entry.label]);
    // Группа «Тренировки» ведёт на первый её пункт (Сегодня) — это и есть
    // общий вход в раздел, откуда дальше выбирают конкретное занятие.
    b.addEventListener('click', () => show(entry.group ? TRAINING_TABS[0].id : entry.id));
    topButtons.set(entry.id, b);
    primaryRow.append(b);
  }

  for (const t of TRAINING_TABS) {
    const b = el('button', { class: 'tab-secondary', type: 'button' }, [t.label]);
    b.addEventListener('click', () => show(t.id));
    subButtons.set(t.id, b);
    secondaryRow.append(b);
  }

  // Настройки — компактная иконка справа от рядов, а не пункт в их числе:
  // нужна всегда, но не как ещё одна тренировка среди прочих.
  const settingsBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': SETTINGS_TAB.label });
  settingsBtn.innerHTML = SETTINGS_ICON;
  settingsBtn.addEventListener('click', () => show(SETTINGS_TAB.id));
  primaryRow.append(settingsBtn);

  window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '');
    if (id && id !== activeId && ALL_TABS.some((t) => t.id === id)) show(id);
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

  // Первый запуск на устройстве — сначала короткая первоначальная
  // настройка. Дальше она в основную навигацию не возвращается: живёт
  // кнопкой «Настройки».
  let firstRun = false;
  try {
    firstRun = !(await hasSavedCalibration());
  } catch (e) {
    console.warn('Не удалось проверить, настраивались ли раньше', e);
  }
  if (firstRun) {
    nav.classList.add('setup-mode');
    mountView(
      firstRunSetup(() => {
        nav.classList.remove('setup-mode');
        show('today');
      }),
      null,
    );
    return;
  }

  const initial = location.hash.replace('#', '');
  show(ALL_TABS.some((t) => t.id === initial) ? initial : 'today');
}

// Метка сборки нужна и на витрине, а не только внутри приложения: по ней
// сразу видно, доехала ли новая версия, или браузер держит старую из кеша.
const buildEl = document.getElementById('build-id');
if (buildEl) buildEl.textContent = `сборка ${__BUILD_ID__}`;

// Слушаем обновление service worker'а СРАЗУ: пока показана витрина Lab,
// страница работает на старом закешированном JS (там же старый
// WORKER_URL/PUBLIC_KEY_JWK, если их когда-нибудь поменяют). Без этого
// вернувшийся пользователь с устаревшим SW застрял бы на бандле, который
// ходит не туда или не может проверить свежий токен.
reloadOnServiceWorkerUpdate();

// И сразу предлагаем обновиться, если свежая сборка уже скачана и ждёт:
// сама собой новая версия открытую страницу не перехватывает.
watchForUpdate();

// Без доступа boot() вообще не вызывается: вкладки не монтируются,
// IndexedDB не читается. Вместо них в #view — публичная витрина (gate.ts):
// скриншоты режимов и два сценария входа. boot() запускается только после
// верного кода в диалоге «Войти в Lab».
//
// hasAccess() теперь асинхронна: токен проверяется криптографически
// (ECDSA, см. core/access.ts), а не простым сравнением строк — но
// полностью офлайн, сети эта проверка не требует, задержка на глаз не
// заметна.
void (async () => {
  // Сначала — вернулись ли мы сюда запасным входом (переходом через
  // воркер): тогда в #-части адреса лежит свежий токен или причина
  // отказа. consumeLoginFromHash сразу вычищает адрес.
  const fromHash = await consumeLoginFromHash();
  if (fromHash.kind === 'ok' || (await hasAccess())) {
    void boot();
    return;
  }

  let message: string | undefined;
  if (fromHash.kind === 'invalid') message = 'Код не подошёл. Проверьте и попробуйте ещё раз.';
  if (fromHash.kind === 'server')
    message = 'Код верный, но сервер не смог выдать пропуск: проверь ключ подписи.';
  if (fromHash.kind === 'rate_limited') {
    const min = Math.ceil(fromHash.retryAfterMs / 60000);
    message = `Слишком много попыток. Попробуй через ${min} мин.`;
  }
  mountGate(() => void boot(), message);
})();
