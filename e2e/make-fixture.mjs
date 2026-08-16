/**
 * Готовит сборку для сквозного прогона.
 *
 * Приложение закрыто пропуском с подписью ECDSA — подделать её нельзя,
 * и это правильно. Чтобы всё-таки прогнать настоящий интерфейс целиком,
 * генерируем СВОЮ пару ключей, подменяем в собранном бандле публичную
 * половину и подписываем пропуск приватной. Трогается только dist/ уже
 * после сборки: исходники и выкладываемая версия остаются нетронутыми.
 */
import { webcrypto as crypto } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;

// Координаты боевого ключа из src/core/access.ts — их и подменяем.
const REAL_X = 'zWJxvS2Mgia3egqIncKhOGG1G7mULeQmrCSPAAOsNZU';
const REAL_Y = 'aiS86cFUFmBZQ7eL_8KDZzCOKniHmVc76IRJeSqcSKQ';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);

const assets = join(DIST, 'assets');
const bundle = readdirSync(assets).find((f) => f.startsWith('index-') && f.endsWith('.js'));
if (!bundle) throw new Error('не нашёл собранный бандл в dist/assets');
const path = join(assets, bundle);

let code = readFileSync(path, 'utf8');
if (!code.includes(REAL_X)) throw new Error('в бандле нет боевого ключа — подмена не сработает');
code = code.split(REAL_X).join(pub.x).split(REAL_Y).join(pub.y);
writeFileSync(path, code);

// Пропуск на сутки вперёд.
const payload = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }));
const sig = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  pair.privateKey,
  new TextEncoder().encode(payload),
);
const token = `${payload}.${b64url(sig)}`;

writeFileSync(join(DIST, 'e2e-token.txt'), token);
console.log(token);
