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
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Science Chess Lab',
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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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
