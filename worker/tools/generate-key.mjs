#!/usr/bin/env node
/**
 * Генерирует пару ключей ECDSA P-256 для подписи токенов доступа.
 *
 * ВАЖНО: запускай эту команду САМ на своей машине (node worker/tools/generate-key.mjs)
 * — не проси ассистента запустить её за тебя и не вставляй результат в чат
 * или куда-либо ещё. Приватный ключ, который она выведет, — это единственный
 * способ подделать токен доступа; он должен попасть только в
 * `wrangler secret put SIGNING_PRIVATE_KEY_JWK` и никуда больше.
 *
 * Публичный ключ секретом не является (им можно только ПРОВЕРИТЬ подпись,
 * не создать) — его вставляешь напрямую в src/core/access.ts.
 */
import { webcrypto } from 'node:crypto';

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const pub = await webcrypto.subtle.exportKey('jwk', publicKey);
const priv = await webcrypto.subtle.exportKey('jwk', privateKey);

console.log('\n=== Публичный ключ — вставь в src/core/access.ts (PUBLIC_KEY_JWK) ===\n');
console.log(JSON.stringify(pub));

console.log('\n=== Приватный ключ — только в секрет воркера, никуда больше ===\n');
console.log('Выполни и вставь эту строку, когда попросит команда ниже:\n');
console.log(JSON.stringify(priv));
console.log('\nКоманда для сохранения секрета (запусти из папки worker/):');
console.log('  npx wrangler secret put SIGNING_PRIVATE_KEY_JWK\n');
