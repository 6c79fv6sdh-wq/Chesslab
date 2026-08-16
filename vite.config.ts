import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Короткая метка сборки: видно в подписи внизу страницы. */
function buildId(): string {
  let sha = 'local';
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Сборка вне git — не беда.
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())} ${sha}`;
}

export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  plugins: [
    VitePWA({
      // Не 'autoUpdate': тот режим принудительно включает
      // skipWaiting + clientsClaim (см. комментарий к workbox ниже), а
      // именно они ломали сеть на уже открытой странице в Safari.
      // С 'prompt' новый SW спокойно ждёт своей очереди, а предложение
      // обновиться показываем сами (core/update.ts) — и перезагружаемся
      // тут же, так что живую страницу он не захватывает.
      registerType: 'prompt',
      // Регистрируем worker сами (core/update.ts): нужен доступ к событию
      // «новая версия готова», чтобы предложить обновиться.
      injectRegister: null,
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'ScienceChess Lab',
        short_name: 'Chess Lab',
        description: 'Тренажёр моторики и скорости для ultrabullet. Автор: Vladislav Dmitrovsky',
        lang: 'ru',
        start_url: './index.html',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#161512',
        theme_color: '#161512',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Новый service worker НЕ перехватывает уже открытую страницу.
        // С skipWaiting+clientsClaim (значения по умолчанию при autoUpdate)
        // свежий SW захватывал управление посреди жизни страницы — и в
        // Safari на телефоне после этого переставала работать вообще вся
        // сеть страницы: и fetch, и XMLHttpRequest падали с «Load failed»,
        // хотя тот же запрос с обычной страницы того же сайта проходил.
        // Вход становился невозможен. Теперь обновление ждёт, пока
        // приложение закроют, и применяется к следующему заходу — версия
        // видна в подписи внизу, так что понять, доехала ли она, легко.
        skipWaiting: false,
        clientsClaim: false,
        // Изоляция страницы для SharedArrayBuffer: без неё не стартует
        // lc0 с сетью Maia. Подробности — в public/coi.js. Подключаем
        // первым, до маршрутов Workbox: обработчик там аккуратный и
        // берёт на себя только навигации.
        importScripts: ['coi.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        // Движок весит 7 МБ: в предзагрузку не кладём, иначе первое открытие
        // сайта стало бы неприлично тяжёлым. Кешируется при первом использовании.
        // Наборы фигур в предзагрузку не кладём: их четыре, а пользуются
        // одним. Выбранный набор кешируется при первом показе (ниже).
        // lc0 с весами Maia — ещё 2,5 МБ, и нужны они только тем, кто
        // сядет играть с ботом. Тоже мимо предзагрузки.
        globIgnores: ['**/engine/**', '**/piece/**', '**/lc0/**'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/engine\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/piece/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'piece-sets',
              expiration: { maxEntries: 64 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/engine/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'stockfish-engine',
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Правила для /lc0/ здесь нет намеренно: эти запросы забирает на
          // себя coi.js — ему нужно дописать к ответу заголовки изоляции,
          // а Workbox так не умеет. Кеширование там своё, тоже cache-first.
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { host: '0.0.0.0', port: 5173 },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
