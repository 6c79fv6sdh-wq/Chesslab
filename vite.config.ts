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
      // ВРЕМЕННО. Собирает service worker, который сносит сам себя и все
      // кеши. Нужен ровно один такой деплой: у пользователей на телефонах
      // остался старый SW, который перехватывает открытую страницу и
      // ломает в Safari всю её сеть (вход падал с «Load failed» и на
      // fetch, и на XHR). Сам он не уйдёт, пока приложение не закроют
      // полностью, — а закрыть его во встроенном браузере получается не
      // всегда. Этот SW при первом же заходе разрегистрируется, чистит
      // кеши и перезагружает страницу: дальше приложение работает вообще
      // без SW, на чистой сети. Снять флаг следующим деплоем.
      selfDestroying: true,
      // Не 'autoUpdate': тот режим принудительно включает
      // skipWaiting + clientsClaim (см. комментарий к workbox ниже), а
      // именно они ломали сеть на уже открытой странице в Safari.
      // С 'prompt' новый SW спокойно ждёт своей очереди; отдельного
      // диалога «обновиться?» не показываем — версия применится на
      // следующем заходе сама.
      registerType: 'prompt',
      injectRegister: 'auto',
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
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        // Движок весит 7 МБ: в предзагрузку не кладём, иначе первое открытие
        // сайта стало бы неприлично тяжёлым. Кешируется при первом использовании.
        globIgnores: ['**/engine/**'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/engine\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/engine/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'stockfish-engine',
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
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
