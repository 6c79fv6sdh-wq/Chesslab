/**
 * Gate-воркер ScienceChess Lab: единственная задача — проверить код
 * доступа и выдать подписанный короткоживущий токен. Код и приватный
 * ключ подписи существуют только как секреты Cloudflare (wrangler secret
 * put), в этом репозитории их нет и быть не может.
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
 */

export interface Env {
  /** Секрет: wrangler secret put ACCESS_CODE */
  ACCESS_CODE: string;
  /** Секрет: JSON приватного ключа ECDSA P-256 (JWK), см. tools/generate-key.mjs */
  SIGNING_PRIVATE_KEY_JWK: string;
  /** Переменная: источники через запятую, без слэша на конце */
  ALLOWED_ORIGINS: string;
  /** Переменная: срок жизни токена, секунды */
  TOKEN_TTL_SECONDS: string;
  /** KV для счётчика неудачных попыток входа */
  RATE_LIMIT_KV: KVNamespace;
}

// --- Rate limiting -----------------------------------------------------

/** Сколько неудачных попыток подряд терпим, прежде чем включить паузу. */
const ATTEMPTS_BEFORE_LOCK = 5;
/** Первая пауза после превышения лимита. */
const BASE_LOCK_SECONDS = 60;
/** Больше часа не блокируем — это фильтр от перебора, а не бан. */
const MAX_LOCK_SECONDS = 3600;
/** Счётчик обнуляется сам, если сутки не было ни одной попытки. */
const COUNTER_TTL_SECONDS = 24 * 60 * 60;

interface RateRecord {
  fails: number;
  lockedUntil: number; // мс, epoch; 0 — не заблокирован
}

function rateLimitKey(ip: string): string {
  return `rl:${ip}`;
}

async function readRateRecord(env: Env, ip: string): Promise<RateRecord> {
  const raw = await env.RATE_LIMIT_KV.get(rateLimitKey(ip));
  if (!raw) return { fails: 0, lockedUntil: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<RateRecord>;
    return {
      fails: typeof parsed.fails === 'number' ? parsed.fails : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { fails: 0, lockedUntil: 0 };
  }
}

async function writeRateRecord(env: Env, ip: string, rec: RateRecord): Promise<void> {
  await env.RATE_LIMIT_KV.put(rateLimitKey(ip), JSON.stringify(rec), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });
}

async function clearRateRecord(env: Env, ip: string): Promise<void> {
  await env.RATE_LIMIT_KV.delete(rateLimitKey(ip));
}

/**
 * Экспоненциальная пауза: 5 неверных попыток — минута, следующая пятёрка
 * (10, 15, 20...) — пауза удваивается, потолок — час. Так casual-перебор
 * 4-значного кода занял бы часы, а не секунды, а один-два опечатавшихся
 * родителя лишней минуты почти не заметят.
 */
function lockDurationSeconds(fails: number): number {
  const strikes = Math.floor(fails / ATTEMPTS_BEFORE_LOCK);
  if (strikes <= 0) return 0;
  return Math.min(BASE_LOCK_SECONDS * 2 ** (strikes - 1), MAX_LOCK_SECONDS);
}

// --- Подпись токена ------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importSigningKey(env: Env): Promise<CryptoKey> {
  const jwk = JSON.parse(env.SIGNING_PRIVATE_KEY_JWK) as JsonWebKey;
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Токен = base64url(JSON payload) + '.' + base64url(подпись payload). */
async function issueToken(env: Env): Promise<{ token: string; exp: number }> {
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

function constantTimeEqual(a: string, b: string): boolean {
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

function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string | null, allowed: string[]): HeadersInit {
  const allow = origin && allowed.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// --- Обработчик ------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_request' }, 400, cors);
    }
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !code.trim()) {
      return json({ error: 'bad_request' }, 400, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    // ВРЕМЕННО (диагностика 500-й): оборачиваем в try/catch, чтобы увидеть
    // причину исключения в самом ответе, а не только "error code: 1101" от
    // Cloudflare. Убрать после того, как вход снова заработает.
    try {
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
      const next: RateRecord = {
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
    } catch (err) {
      return json(
        {
          error: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
          hasAccessCode: typeof env.ACCESS_CODE === 'string' && env.ACCESS_CODE.length > 0,
          hasSigningKey: typeof env.SIGNING_PRIVATE_KEY_JWK === 'string' && env.SIGNING_PRIVATE_KEY_JWK.length > 0,
          hasKv: typeof env.RATE_LIMIT_KV !== 'undefined',
        },
        500,
        cors,
      );
    }
  },
};
