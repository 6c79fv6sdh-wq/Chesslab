import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { STORAGE_KEY, isLoginInFlight, loginTo, verifyTokenWithKey } from '../src/core/access';

/**
 * Проверка кода теперь живёт на сервере (Cloudflare Worker, см.
 * worker/src/index.ts) — здесь тестируется только сторона фронтенда:
 * офлайн-проверка подписи токена (verifyTokenWithKey) и разбор ответа
 * воркера (loginTo). Ключ и WORKER_URL модуля намеренно остаются пустыми
 * до деплоя, поэтому обе функции параметризованы — тестовая пара ключей
 * и мок fetch, а не настоящий деплой.
 */

function toBase64Url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeKeyPair() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey;
  return { publicJwk, privateKey };
}

async function signToken(privateKey: CryptoKey, exp: number): Promise<string> {
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp })));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payloadB64),
  );
  return `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

describe('verifyTokenWithKey: офлайн-проверка подписи и срока', () => {
  let publicJwk: JsonWebKey;
  let privateKey: CryptoKey;
  let otherPublicJwk: JsonWebKey;

  beforeAll(async () => {
    const pair = await makeKeyPair();
    publicJwk = pair.publicJwk;
    privateKey = pair.privateKey;
    otherPublicJwk = (await makeKeyPair()).publicJwk;
  });

  it('настоящий, ещё не истёкший токен — валиден', async () => {
    const token = await signToken(privateKey, Math.floor(Date.now() / 1000) + 3600);
    expect(await verifyTokenWithKey(token, publicJwk)).toBe(true);
  });

  it('истёкший токен (exp в прошлом) — невалиден', async () => {
    const token = await signToken(privateKey, Math.floor(Date.now() / 1000) - 10);
    expect(await verifyTokenWithKey(token, publicJwk)).toBe(false);
  });

  it('токен, подписанный ЧУЖИМ ключом, — невалиден даже с верным payload', async () => {
    // Имитирует попытку подделать токен, зная только публичный ключ
    // (который не секрет) — подписать им ничего нельзя.
    const other = await makeKeyPair();
    const forged = await signToken(other.privateKey, Math.floor(Date.now() / 1000) + 3600);
    expect(await verifyTokenWithKey(forged, publicJwk)).toBe(false);
  });

  it('токен, проверенный НЕ тем публичным ключом, — невалиден', async () => {
    const token = await signToken(privateKey, Math.floor(Date.now() / 1000) + 3600);
    expect(await verifyTokenWithKey(token, otherPublicJwk)).toBe(false);
  });

  it('подпись верна, но payload подменён после подписи, — невалиден', async () => {
    const token = await signToken(privateKey, Math.floor(Date.now() / 1000) + 3600);
    const [payloadB64, sigB64] = token.split('.');
    const tampered = `${payloadB64 === 'a' ? 'b' : 'a'}${payloadB64.slice(1)}.${sigB64}`;
    expect(await verifyTokenWithKey(tampered, publicJwk)).toBe(false);
  });

  it('произвольный мусор вместо токена — false, без исключения', async () => {
    await expect(verifyTokenWithKey('not-a-token-at-all', publicJwk)).resolves.toBe(false);
    await expect(verifyTokenWithKey('', publicJwk)).resolves.toBe(false);
    await expect(verifyTokenWithKey('a.b.c', publicJwk)).resolves.toBe(false);
    await expect(verifyTokenWithKey('..', publicJwk)).resolves.toBe(false);
  });

  it('без публичного ключа (PUBLIC_KEY_JWK не заполнен) — всегда false', async () => {
    const token = await signToken(privateKey, Math.floor(Date.now() / 1000) + 3600);
    expect(await verifyTokenWithKey(token, null)).toBe(false);
  });

  it('payload без числового exp — невалиден', async () => {
    const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: 'скоро' })));
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(payloadB64),
    );
    const token = `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
    expect(await verifyTokenWithKey(token, publicJwk)).toBe(false);
  });
});

describe('loginTo: разбор ответа воркера', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('без адреса воркера — not_configured, fetch не вызывается', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await loginTo('', '2000');
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('200 с токеном — ok, токен сохранён в localStorage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'abc.def', exp: 123 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', '2000');
    expect(result).toEqual({ ok: true });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('abc.def');
  });

  it('POST шлёт код в JSON-теле на /login', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 't' }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await loginTo('https://gate.example', '  MyCode  ');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://gate.example/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: '  MyCode  ' }),
      }),
    );
  });

  it('401 — invalid, ничего не пишет в localStorage', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_code' }), { status: 401 })) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', 'wrong');
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('429 — rate_limited с retryAfterMs из тела ответа', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate_limited', retryAfterMs: 45000 }), { status: 429 }),
      ) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', 'x');
    expect(result).toEqual({ ok: false, reason: 'rate_limited', retryAfterMs: 45000 });
  });

  it('429 без тела/с битым телом — запасное значение retryAfterMs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 429 })) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
      if (result.reason === 'rate_limited') expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('обрыв сети (fetch бросает) — network, не падает', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', 'x');
    // debug — временное диагностическое поле, содержимое не проверяем строго.
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('200, но тело без токена (некорректный ответ) — network, не ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', 'x');
    expect(result).toMatchObject({ ok: false, reason: 'network' });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  /**
   * Регрессия: пока идёт проверка кода, страницу нельзя перезагружать по
   * обновлению service worker'а (main.ts) — иначе запрос обрывается и вход
   * падает с «network», хотя сеть и воркер исправны. Именно это ломало вход
   * на телефоне после каждого свежего деплоя.
   */
  it('пока запрос в полёте, isLoginInFlight() — true, после — false', async () => {
    expect(isLoginInFlight()).toBe(false);
    let duringRequest: boolean | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      duringRequest = isLoginInFlight();
      return new Response(JSON.stringify({ token: 't' }), { status: 200 });
    }) as unknown as typeof fetch;

    await loginTo('https://gate.example', '2000');

    expect(duringRequest).toBe(true);
    expect(isLoginInFlight()).toBe(false);
  });

  it('после неудачного запроса счётчик тоже обнуляется', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    await loginTo('https://gate.example', 'x');
    expect(isLoginInFlight()).toBe(false);
  });

  it('прочий код статуса (403, 500...) трактуется как invalid', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 })) as unknown as typeof fetch;
    const result = await loginTo('https://gate.example', 'x');
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });
});
