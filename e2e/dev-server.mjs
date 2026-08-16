/**
 * Локальный сервер для e2e/strength-run.mjs — тот же vite dev, но с
 * заголовками COOP/COEP: без них SharedArrayBuffer недоступен и lc0
 * (Maia) не поднимается. Обычный `npm run dev` эти заголовки не ставит
 * намеренно — GitHub Pages их тоже не ставит, а страница в бою получает
 * изоляцию через service worker (public/coi.js, см. README «Человекоподобные
 * боты» → «Изоляция страницы»). Для замера силы бота ждать сборку и
 * второй заход service worker'а не нужно — проще поднять dev-сервер с
 * заголовками сразу.
 */
import { createServer } from 'vite';

const server = await createServer({
  server: {
    port: 5602,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
await server.listen();
server.printUrls();
