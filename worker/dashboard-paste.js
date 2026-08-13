/**
 * Это НЕ используется wrangler-деплоем — тот берёт код из src/index.ts.
 * Этот файл — просто готовая копия той же логики без TypeScript-синтаксиса,
 * чтобы её можно было целиком вставить в Cloudflare Dashboard → Workers →
 * твой воркер → Edit code (Quick Edit), если разворачиваешь без терминала,
 * прямо с телефона/планшета.
 *
 * Если когда-нибудь поменяешь логику в src/index.ts — обнови и этот файл
 * тем же изменением, вручную (build здесь не участвует).
 *
 * Gate-воркер ScienceChess Lab: единственная задача — проверить код
 * доступа и выдать подписанный короткоживущий токен. Код и приватный
 * ключ подписи существуют только как секреты Cloudflare (Settings →
 * Variables and Secrets → Encrypt), в этом репозитории их нет и быть
 * не может.
 *
 * Проверка токена на фронтенде — офлайн, по публичному ключу подписи
 * (см. src/core/access.ts): чтобы вернувшийся ученик с валидным токеном
 * не спрашивал сеть каждый раз, обращение сюда нужно только при вводе
 * кода. Именно поэтому подпись асимметричная (ECDSA), а не HMAC — с HMAC
 * проверить токен без сети мог бы только тот, кто знает секрет, то есть
 * снова этот воркер.
 *
 * Единственный маршрут: POST /login { code } →
 *   200 { token, exp } — код верный, token подписан и живёт TOKEN_TTL_SECONDS
 *   401 { error: 'invalid_code' } — код неверный
 *   429 { error: 'rate_limited', retryAfterMs } — слишком много попыток подряд
 *   403 — запрос не с разрешённого источника (см. ALLOWED_ORIGINS)
 *
 * Ожидаемые привязки/переменные воркера (Settings → Variables and Secrets):
 *   ACCESS_CODE              — секрет (Encrypt), сам код доступа
 *   SIGNING_PRIVATE_KEY_JWK  — секрет (Encrypt), JSON приватного ключа
 *                              ECDSA P-256 (JWK) — сгенерировать в «Кузнице
 *                              ключей», см. README
 *   ALLOWED_ORIGINS          — обычная переменная (Text), источники через
 *                              запятую, без слэша на конце
 *   TOKEN_TTL_SECONDS        — обычная переменная (Text), срок жизни
 *                              токена, секунды, например 2592000
 *   RATE_LIMIT_KV            — привязка KV-неймспейса (Bindings → KV
 *                              Namespace), имя привязки должно быть точно
 *                              RATE_LIMIT_KV
 */

// --- Rate limiting -----------------------------------------------------

/** Сколько неудачных попыток подряд терпим, прежде чем включить паузу. */
const ATTEMPTS_BEFORE_LOCK = 5;
/** Первая пауза после превышения лимита. */
const BASE_LOCK_SECONDS = 60;
/** Больше часа не блокируем — это фильтр от перебора, а не бан. */
const MAX_LOCK_SECONDS = 3600;
/** Счётчик обнуляется сам, если сутки не было ни одной попытки. */
const COUNTER_TTL_SECONDS = 24 * 60 * 60;

function rateLimitKey(ip) {
  return `rl:${ip}`;
}

async function readRateRecord(env, ip) {
  const raw = await env.RATE_LIMIT_KV.get(rateLimitKey(ip));
  if (!raw) return { fails: 0, lockedUntil: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      fails: typeof parsed.fails === 'number' ? parsed.fails : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { fails: 0, lockedUntil: 0 };
  }
}

async function writeRateRecord(env, ip, rec) {
  await env.RATE_LIMIT_KV.put(rateLimitKey(ip), JSON.stringify(rec), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });
}

async function clearRateRecord(env, ip) {
  await env.RATE_LIMIT_KV.delete(rateLimitKey(ip));
}

/**
 * Экспоненциальная пауза: 5 неверных попыток — минута, следующая пятёрка
 * (10, 15, 20...) — пауза удваивается, потолок — час. Так casual-перебор
 * 4-значного кода занял бы часы, а не секунды, а один-два опечатавшихся
 * родителя лишней минуты почти не заметят.
 */
function lockDurationSeconds(fails) {
  const strikes = Math.floor(fails / ATTEMPTS_BEFORE_LOCK);
  if (strikes <= 0) return 0;
  return Math.min(BASE_LOCK_SECONDS * 2 ** (strikes - 1), MAX_LOCK_SECONDS);
}

// --- Подпись токена ------------------------------------------------------

function toBase64Url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importSigningKey(env) {
  const jwk = JSON.parse(env.SIGNING_PRIVATE_KEY_JWK);
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Токен = base64url(JSON payload) + '.' + base64url(подпись payload). */
async function issueToken(env) {
  const ttl = Number(env.TOKEN_TTL_SECONDS) || 2592000;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ exp }));
  const payloadB64 = toBase64Url(payloadBytes);

  const key = await importSigningKey(env);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(payloadB64),
  );
  const sigB64 = toBase64Url(new Uint8Array(sig));

  return { token: `${payloadB64}.${sigB64}`, exp };
}

// --- Постоянное сравнение строк (без утечки по времени ответа) --------

function constantTimeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Длину скрыть constant-time сравнением не выйдет (a.length/b.length уже
  // видны раньше), но для короткого кода это не даёт атакующему ничего
  // полезного — существенна именно защита посимвольного сравнения.
  if (ab.length !== bb.length) {
    // Всё равно проходим по более длинному массиву, чтобы время ответа
    // не отличалось по грубой оценке от случая верной длины.
    let dummy = 0;
    for (let i = 0; i < Math.max(ab.length, bb.length); i++) dummy |= (ab[i] ?? 0) ^ (bb[i] ?? 0) ^ 1;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// --- CORS ----------------------------------------------------------------

function allowedOrigins(env) {
  return env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin, allowed) {
  const allow = origin && allowed.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// --- Запасной вход через отправку формы -----------------------------------

/** Вернуться на страницу приложения, добавив результат в #-часть адреса. */
function redirectBack(returnUrl, fragment) {
  // 303: браузер обязан продолжить обычным GET, а не повторить POST.
  return new Response(null, { status: 303, headers: { Location: `${returnUrl}#${fragment}` } });
}

/**
 * Тот же вход, что и /login, но результат отдаётся не JSON'ом, а
 * перенаправлением обратно на приложение. Токен кладём в #-часть адреса
 * (её браузер не отправляет на сервер), ошибку — тоже.
 */
async function handleLoginForm(request, env, allowed) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response('bad_request', { status: 400 });
  }

  const returnUrl = String(form.get('return') ?? '');
  // Куда возвращаемся — проверяем строго: иначе это открытый редирект, а
  // вместе с ним и утечка токена на чужой сайт. Свой origin, без своей
  // #-части (её мы добавляем сами).
  const returnOk =
    !returnUrl.includes('#') && allowed.some((o) => returnUrl === o || returnUrl.startsWith(`${o}/`));
  if (!returnOk) return new Response('forbidden_return', { status: 403 });

  const code = String(form.get('code') ?? '');
  if (!code.trim()) return redirectBack(returnUrl, 'lab-error=invalid');

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const rec = await readRateRecord(env, ip);
  const now = Date.now();

  if (rec.lockedUntil > now) {
    return redirectBack(returnUrl, `lab-error=rate&retry=${rec.lockedUntil - now}`);
  }

  const correct = constantTimeEqual(code.trim().toLowerCase(), env.ACCESS_CODE.trim().toLowerCase());

  if (correct) {
    if (rec.fails > 0) await clearRateRecord(env, ip);
    const { token } = await issueToken(env);
    return redirectBack(returnUrl, `lab-token=${token}`);
  }

  const fails = rec.fails + 1;
  const lockSeconds = lockDurationSeconds(fails);
  await writeRateRecord(env, ip, {
    fails,
    lockedUntil: lockSeconds > 0 ? now + lockSeconds * 1000 : 0,
  });

  if (lockSeconds > 0) return redirectBack(returnUrl, `lab-error=rate&retry=${lockSeconds * 1000}`);
  return redirectBack(returnUrl, 'lab-error=invalid');
}

// --- Обработчик ------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = allowedOrigins(env);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      // Без CORS-проверки: просто сигнал живости для ручной проверки деплоя,
      // ничего чувствительного не отдаёт.
      return new Response('sciencechess-lab-gate: ok', { status: 200 });
    }

    // Запасной вход — обычной отправкой формы, без fetch и без CORS.
    // Нужен потому, что на живом телефоне (Safari во встроенном браузере)
    // фоновый запрос к воркеру падал с «Load failed» и через fetch, и
    // через XHR, хотя обычный переход по адресу работал безотказно. Здесь
    // браузер просто уходит на воркер и возвращается обратно с токеном в
    // #-части адреса — она на сервер не отправляется и в логах не оседает.
    if (url.pathname === '/login-form' && request.method === 'POST') {
      return handleLoginForm(request, env, allowed);
    }

    if (url.pathname !== '/login' || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404, cors);
    }

    // CORS-заголовки в ответе браузер и сам не пропустит дальше при
    // несовпадении Origin, но это ограничение соблюдает только браузер.
    // Прямой запрос (curl, скрипт) его не видит — поэтому источник
    // проверяем и на сервере, отказывая явно, а не молча без заголовков.
    if (!origin || !allowed.includes(origin)) {
      return json({ error: 'forbidden_origin' }, 403, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_request' }, 400, cors);
    }
    const code = body?.code;
    if (typeof code !== 'string' || !code.trim()) {
      return json({ error: 'bad_request' }, 400, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const rec = await readRateRecord(env, ip);
    const now = Date.now();

    if (rec.lockedUntil > now) {
      return json(
        { error: 'rate_limited', retryAfterMs: rec.lockedUntil - now },
        429,
        { ...cors, 'Retry-After': String(Math.ceil((rec.lockedUntil - now) / 1000)) },
      );
    }

    const normalized = code.trim().toLowerCase();
    const correct = constantTimeEqual(normalized, env.ACCESS_CODE.trim().toLowerCase());

    if (correct) {
      if (rec.fails > 0) await clearRateRecord(env, ip);
      const { token, exp } = await issueToken(env);
      return json({ token, exp }, 200, cors);
    }

    const fails = rec.fails + 1;
    const lockSeconds = lockDurationSeconds(fails);
    const next = {
      fails,
      lockedUntil: lockSeconds > 0 ? now + lockSeconds * 1000 : 0,
    };
    await writeRateRecord(env, ip, next);

    if (lockSeconds > 0) {
      return json(
        { error: 'rate_limited', retryAfterMs: lockSeconds * 1000 },
        429,
        { ...cors, 'Retry-After': String(lockSeconds) },
      );
    }
    return json({ error: 'invalid_code' }, 401, cors);
  },
};
