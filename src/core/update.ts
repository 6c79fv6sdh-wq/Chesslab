import { registerSW } from 'virtual:pwa-register';
import { el } from './ui';

/**
 * Предложение обновиться, когда новая версия уже скачана.
 *
 * Новый service worker намеренно НЕ захватывает открытую страницу сам
 * (skipWaiting: false, см. vite.config.ts — от захвата в Safari отваливалась
 * вся сеть страницы). Но тогда свежая сборка просто ждёт, пока приложение
 * закроют совсем: на планшете вкладка живёт неделями, и можно всё это время
 * сидеть на старом коде, гадая, почему исправление «не приехало». Поэтому
 * спрашиваем явно — и перезагружаемся сразу же, так что захватывать живую
 * страницу новому worker'у не приходится.
 */
export function watchForUpdate(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      showUpdateBar(() => void updateSW(true));
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      // Спрашиваем сервер при каждом возврате к странице: фоновые таймеры
      // iOS усыпляет, а вкладку тут не закрывают месяцами.
      const check = (): void => {
        if (document.visibilityState === 'visible') void reg.update();
      };
      document.addEventListener('visibilitychange', check);
      window.addEventListener('focus', check);
    },
  });
}

function showUpdateBar(onUpdate: () => void): void {
  if (document.getElementById('update-bar')) return;
  const btn = el('button', { class: 'btn primary', type: 'button' }, ['Обновить']);
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Обновляю…';
    onUpdate();
  });
  const later = el('button', { class: 'btn', type: 'button' }, ['Потом']);
  const bar = el('div', { id: 'update-bar', role: 'status' }, [
    el('span', {}, ['Есть новая версия Lab.']),
    btn,
    later,
  ]);
  later.addEventListener('click', () => bar.remove());
  document.body.append(bar);
}
