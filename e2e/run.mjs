/**
 * Сквозной прогон по собранному приложению.
 *
 * Сервер отдаёт dist/ БЕЗ заголовков COOP/COEP — ровно как GitHub Pages.
 * Значит проверяем и то, ради чего затевался service worker: изоляция
 * страницы должна появиться сама со второго открытия, и только после неё
 * становится доступна Maia.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const PORT = 5711;
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pb': 'application/octet-stream',
  '.txt': 'text/plain',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let file = join(DIST, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (url.pathname === '/' || url.pathname.endsWith('/')) file = join(file, 'index.html');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const token = (await readFile(join(DIST, 'e2e-token.txt'), 'utf8')).trim();
const base = `http://localhost:${PORT}/`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text());
});

// Пропуск кладём до первой загрузки скриптов.
await page.addInitScript((t) => localStorage.setItem('sciencechess-lab-access', t), token);

// --- первое открытие: изоляции ещё нет, service worker только ставится ---
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
check('первое открытие не изолировано (как и ожидалось)', !(await page.evaluate(() => self.crossOriginIsolated)));

// --- второе открытие: worker уже управляет страницей и даёт изоляцию ---
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
let isolated = await page.evaluate(() => self.crossOriginIsolated);
if (!isolated) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  isolated = await page.evaluate(() => self.crossOriginIsolated);
}
check('service worker включил изоляцию страницы', isolated);
check('SharedArrayBuffer доступен', await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined'));

// --- экран профиля ---
const nameField = page.locator('#profile-name');
check('первым делом спрашивают имя', await nameField.isVisible());
const bodyText = await page.locator('body').innerText();
check('чужих профилей на экране нет', !/Ученик|список профилей/i.test(bodyText));

await nameField.fill('Ваня');
await page.getByRole('button', { name: 'Продолжить' }).click();
await page.waitForTimeout(1200);

// Свежий браузер: после имени идёт первоначальная настройка доски.
const setupDone = page.getByRole('button', { name: /Готово, к тренировке/ });
if (await setupDone.count()) {
  check('первый запуск ведёт в настройку доски', true);
  await setupDone.click();
  await page.waitForTimeout(1000);
}

const tabs = await page.locator('#tabs .tab-primary').allInnerTexts();
check('после имени открылось приложение', tabs.length > 0, tabs.join(' / '));
check('вкладка «Мои партии» на месте', tabs.includes('Мои партии'));

// --- партия с ботом: верхний уровень навигации, «Спарринг» = «Цейтнот» ---
const tab = (name) => page.locator('#tabs .tab-primary', { hasText: new RegExp(`^${name}$`) });
await tab('Спарринг').click();
await page.waitForTimeout(600);
const botNames = await page.locator('.panel', { hasText: 'СОПЕРНИК' }).locator('.seg-btn').allInnerTexts();
check('в списке соперников есть Maia-боты', botNames.some((n) => /Майя|Новичок/.test(n)), botNames.join(' / '));

const tcNames = await page.locator('.row', { hasText: 'Контроль' }).locator('.seg-btn').allInnerTexts();
check('появились нормальные контроли', tcNames.includes('5+3') && tcNames.includes('Без часов'), tcNames.join(' / '));

// Самый слабый бот, без часов — чтобы прогон не зависел от скорости машины.
await page.getByRole('button', { name: 'Новичок', exact: true }).click();
await page.getByRole('button', { name: 'Без часов', exact: true }).click();
await page.getByRole('button', { name: 'Старт', exact: true }).click();

// Ждём, пока Maia поднимется и станет наш ход.
await page.waitForFunction(
  () => document.querySelector('.prompt')?.textContent?.includes('Твой ход'),
  null,
  { timeout: 120000 },
).catch(() => {});
const prompt = await page.locator('.prompt').first().innerText();
check('партия началась', /Твой ход/.test(prompt), prompt);

// Делаем ход e2e4 кликом по доске.
async function clickSquare(square) {
  const box = await page.locator('.hl-board cg-board').boundingBox();
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  await page.mouse.click(box.x + (file + 0.5) * (box.width / 8), box.y + (7.5 - rank) * (box.height / 8));
}
await clickSquare('e2');
await page.waitForTimeout(150);
await clickSquare('e4');
await page.waitForTimeout(4000);

const movesPlayed = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('sciencechess-hyperlab');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const games = await new Promise((res, rej) => {
    const r = db.transaction('games').objectStore('games').getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return games.map((g) => ({
    moves: g.moves.map((m) => m.san),
    pgn: g.pgn,
    status: g.status,
    bot: g.bot.name,
    tc: g.timeControl.label,
    profileId: g.profileId,
  }));
});
const g = movesPlayed[0];
check('партия сохранилась в базу сама', !!g, g ? `${g.bot} · ${g.tc}` : 'записи нет');
check('ход игрока записан', !!g && g.moves[0] === 'e4', g?.moves.join(' '));
check('бот ответил своим ходом', !!g && g.moves.length >= 2, g?.moves.join(' '));
check('PGN собран с тегами', !!g && g.pgn.includes('[White ') && g.pgn.includes('[Result '), '');
check('партия помечена как недоигранная', !!g && g.status === 'live');
check('партия привязана к профилю', !!g && !!g.profileId);

// --- «Мои партии»: список, разбор, продолжение ---
await tab('Мои партии').click();
await page.waitForTimeout(800);
const rows = await page.locator('.game-row').count();
check('партия видна в «Моих партиях»', rows >= 1, `строк: ${rows}`);

await page.locator('.game-row').first().click();
await page.waitForTimeout(800);
const chips = await page.locator('.move-chip').count();
check('в разборе есть лента ходов', chips >= 2, `ходов: ${chips}`);
check('недоигранную можно продолжить', await page.getByRole('button', { name: 'Продолжить партию' }).isVisible());

await page.getByRole('button', { name: 'Продолжить партию' }).click();
await page.waitForTimeout(6000);
const resumed = await page.evaluate(() => document.querySelector('.prompt')?.textContent ?? '');
check('партия доигрывается с того же места', /Твой ход|восстановлена|Ход соперника/.test(resumed), resumed);

// --- профиль изолирует данные ---
// Настройки — компактная иконка справа от рядов, без текстовой подписи.
await page.locator('#tabs .icon-btn[aria-label="Настройки"]').click();
await page.waitForTimeout(500);
check('в настройках есть свой профиль', (await page.locator('.panel', { hasText: 'ПРОФИЛЬ' }).count()) > 0);

console.log('\n──────────────────────────────');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} проверок пройдено`);
if (failed.length) console.log('Провалено:\n' + failed.map((f) => `  • ${f.name}`).join('\n'));

await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
