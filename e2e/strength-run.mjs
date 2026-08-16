import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const games = process.argv[2] ?? '2';
const plies = process.argv[3] ?? '40';
const bots  = process.argv[4] ?? 'maia-novice,maia-1000,maia-1100,sf-1400';
const temps = process.argv[5] ? `&temps=${process.argv[5]}` : '';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => { const t = m.text(); if (!t.startsWith('[vite]')) console.log(t); });
await page.goto(`http://127.0.0.1:5602/e2e/strength.html?games=${games}&plies=${plies}&bots=${bots}${temps}`);
await page.waitForFunction(() => window.REPORT !== undefined, null, { timeout: 3_600_000 });
const r = await page.evaluate(() => window.REPORT);
console.log('\n╔══════════════════════ ЗАМЕР СИЛЫ ══════════════════════');
if (Array.isArray(r)) {
  console.log('║ бот                 заявлено   ACPL   зевков%   очки');
  for (const b of r) {
    console.log(`║ ${b.bot.padEnd(20)} ${String(b.rating ?? '—').padStart(6)}   ${String(b.acpl).padStart(5)}   ${String(b.blunderRate).padStart(6)}   ${b.score}/${b.games}`);
  }
} else console.log(r);
console.log('╚════════════════════════════════════════════════════════');
await browser.close();
