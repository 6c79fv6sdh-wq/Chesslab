/**
 * Экран доступа: код проверяется на сервере (Cloudflare Worker), не
 * здесь. В этом файле и во всём собранном бандле самого кода нет и быть
 * не может — раньше он лежал прямо в JS константой, теперь его знает
 * только воркер (Cloudflare Secret, см. worker/README и README корня).
 *
 * После верного кода воркер выдаёт короткоживущий токен, подписанный
 * приватным ключом ECDSA P-256, который знает только он. Токен хранится
 * в localStorage, а на каждом заходе проверяется ЗДЕСЬ, офлайн, по
 * публичному ключу (публичный ключ — не секрет: им можно только
 * ПРОВЕРИТЬ чужую подпись, не создать новую) — поэтому вернувшийся
 * ученик с валидным токеном не спрашивает сеть на каждом заходе, и
 * приложение по-прежнему открывается офлайн, как и раньше.
 */

/** Куда ведёт кнопка «Обсудить занятия» на экране входа. */
export const CONTACT_TELEGRAM_URL = 'https://t.me/vLdm56';
export const CONTACT_WHATSAPP_URL = 'https://wa.me/79017002756';

/**
 * Адрес задеплоенного воркера (worker/, деплой через Cloudflare Git-сборку
 * из ветки claude/sciencechess-hyperlab-n3ng4f). Без слэша на конце.
 */
const WORKER_URL = 'https://chesslab.6c79fv6sdh.workers.dev';

/**
 * Публичный ключ ECDSA P-256 (JWK) воркера — не секрет: им нельзя
 * подделать токен, только проверить настоящую подпись воркера.
 * Приватная половина этой же пары — секрет SIGNING_PRIVATE_KEY_JWK
 * воркера, здесь её нет и быть не должно.
 */
const PUBLIC_KEY_JWK: JsonWebKey | null = {
  crv: 'P-256',
  ext: true,
  key_ops: ['verify'],
  kty: 'EC',
  x: '3PKcewh-cg6u5ca4mP3D9mvR4Lmj72qFns5pS1tm-hA',
  y: 'T8hy9GTPwe1Qdq5rGriiTVq3YqoIZokAyT5CtRCcWew',
};

/** Не секрет — просто ключ localStorage, экспортирован для тестов. */
export const STORAGE_KEY = 'sciencechess-lab-access';

interface TokenPayload {
  /** unix-секунды */
  exp: number;
}

// Фронтенд только ПРОВЕРЯЕТ токен — в отличие от воркера, кодировать
// (base64url → строка) здесь ничего не нужно, только декодировать обратно.
function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Импортируем ключ один раз и переиспользуем — он не меняется в рантайме.
// Кешируем только реальный ключ модуля (importKeyFor(null) в тестах —
// намеренно каждый раз заново, там это не горячий путь).
let cachedRealKey: Promise<CryptoKey> | null = null;
function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk === PUBLIC_KEY_JWK) {
    if (!cachedRealKey) {
      cachedRealKey = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'verify',
      ]);
    }
    return cachedRealKey;
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/**
 * Подпись и срок годности токена верны по конкретному публичному ключу?
 * Полностью офлайн: сеть здесь не нужна — только к воркеру при самом
 * вводе кода (см. login ниже). Ключ параметром — чтобы можно было
 * проверить логику тестом на собственной паре ключей, не трогая
 * PUBLIC_KEY_JWK модуля.
 */
export async function verifyTokenWithKey(token: string, jwk: JsonWebKey | null): Promise<boolean> {
  if (!jwk) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  try {
    const key = await importVerifyKey(jwk);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromBase64Url(sigB64),
      new TextEncoder().encode(payloadB64),
    );
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as Partial<TokenPayload>;
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    // Битый токен, чужой формат JSON — в любом случае просто «доступа
    // нет», а не падение приложения.
    return false;
  }
}

/** Уже входили на этом устройстве и токен ещё не истёк? */
export async function hasAccess(): Promise<boolean> {
  let token: string | null;
  try {
    token = localStorage.getItem(STORAGE_KEY);
  } catch {
    return false; // приватный режим/заблокированный localStorage
  }
  if (!token) return false;
  return verifyTokenWithKey(token, PUBLIC_KEY_JWK);
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Не критично: просто будет спрашивать код при следующем открытии.
  }
}

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number }
  | { ok: false; reason: 'network'; debug?: string } // debug: ВРЕМЕННО, для диагностики
  | { ok: false; reason: 'not_configured' };

/**
 * Собственно запрос к воркеру — адрес параметром, чтобы можно было
 * протестировать разбор ответа (200/401/429/битый JSON/обрыв сети) без
 * настоящего WORKER_URL, который до деплоя пуст намеренно.
 */
export async function loginTo(workerUrl: string, code: string): Promise<LoginResult> {
  if (!workerUrl) return { ok: false, reason: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(`${workerUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    // ВРЕМЕННО (диагностика): реальная причина в debug, уберу после починки.
    const debug = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, reason: 'network', debug };
  }

  if (res.status === 200) {
    const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
    if (typeof data?.token !== 'string')
      return { ok: false, reason: 'network', debug: `status 200, data=${JSON.stringify(data)}` };
    storeToken(data.token);
    return { ok: true };
  }

  if (res.status === 429) {
    const data = (await res.json().catch(() => null)) as { retryAfterMs?: unknown } | null;
    const retryAfterMs = typeof data?.retryAfterMs === 'number' ? data.retryAfterMs : 60_000;
    return { ok: false, reason: 'rate_limited', retryAfterMs };
  }

  return { ok: false, reason: 'invalid' };
}

/**
 * Отправить код воркеру по HTTPS. При успехе токен уже сохранён в
 * localStorage — вызывающему коду достаточно проверить result.ok.
 */
export function login(code: string): Promise<LoginResult> {
  return loginTo(WORKER_URL, code);
}
