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

/**
 * Куда отправлять форму запасного входа (см. gate.ts). Обычная отправка
 * формы — это переход, а не фоновый запрос: ни fetch, ни CORS в нём не
 * участвуют. Понадобилось потому, что на живом телефоне фоновый запрос
 * падал с «Load failed» и через fetch, и через XHR, а переход по адресу
 * работал безотказно.
 */
export const LOGIN_FORM_ACTION = WORKER_URL ? `${WORKER_URL}/login-form` : '';

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

/** Что вернул запасной вход, если возвращались через него. */
export type HashLoginOutcome =
  | { kind: 'none' }
  | { kind: 'ok' }
  | { kind: 'invalid' }
  | { kind: 'server' }
  | { kind: 'rate_limited'; retryAfterMs: number };

/**
 * Разобрать #-часть адреса после возврата от воркера: там либо свежий
 * токен, либо причина отказа. В любом случае сразу вычищаем её из адреса,
 * чтобы токен не остался в строке браузера и в истории.
 */
export async function consumeLoginFromHash(): Promise<HashLoginOutcome> {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!raw) return { kind: 'none' };

  const params = new URLSearchParams(raw);
  const token = params.get('lab-token');
  const error = params.get('lab-error');
  if (!token && !error) return { kind: 'none' };

  // Чистим адрес до любых await: пусть токен исчезнет из строки сразу.
  history.replaceState(null, '', location.pathname + location.search);

  if (token) {
    if (await verifyTokenWithKey(token, PUBLIC_KEY_JWK)) {
      storeToken(token);
      return { kind: 'ok' };
    }
    return { kind: 'invalid' };
  }

  if (error === 'server') return { kind: 'server' };
  if (error === 'rate') {
    const retry = Number(params.get('retry'));
    return { kind: 'rate_limited', retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry : 60_000 };
  }
  return { kind: 'invalid' };
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
  | { ok: false; reason: 'network' }
  /** Код верный, но сервер не смог выдать пропуск — см. signing_key_invalid. */
  | { ok: false; reason: 'server' }
  | { ok: false; reason: 'not_configured' };

/**
 * Сколько запросов к воркеру сейчас в полёте. Нужно наружу ровно одному
 * месту — обработчику обновления service worker'а (main.ts): страницу
 * нельзя перезагружать, пока идёт проверка кода, иначе запрос обрывается
 * на полпути и вход падает с «не получилось проверить код», хотя и сеть,
 * и воркер исправны. Ровно это и ломало вход после каждого нового деплоя.
 */
let inFlight = 0;
export function isLoginInFlight(): boolean {
  return inFlight > 0;
}

/** Ответ воркера, приведённый к общему виду для всех трёх способов связи. */
interface RawResponse {
  status: number;
  text: string;
}

/** Последний способ связи: XMLHttpRequest мимо fetch целиком. */
function postViaXhr(url: string, body: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest === 'undefined') {
      reject(new Error('XMLHttpRequest недоступен'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error('XHR: сетевая ошибка'));
    xhr.ontimeout = () => reject(new Error('XHR: таймаут'));
    xhr.send(body);
  });
}

/**
 * Достучаться до воркера, перебирая способы связи, пока один не сработает.
 *
 * Казалось бы, хватило бы обычного fetch — но на живом телефоне (Safari во
 * встроенном браузере) он падал с «TypeError: Load failed», хотя ровно тот
 * же запрос с той же страницы через XMLHttpRequest проходил и возвращал
 * честный 401. Причину на стороне браузера воспроизвести не удалось, а
 * вход должен работать, поэтому пробуем по очереди:
 *
 *   1. обычный fetch с Content-Type (нужен preflight);
 *   2. fetch без своих заголовков — «простой» запрос, preflight не нужен;
 *   3. XMLHttpRequest — мимо fetch целиком.
 *
 * Воркер разбирает тело через request.json() и к Content-Type не
 * придирается, поэтому все три варианта для него одинаковы. Переходим к
 * следующему только при обрыве связи: любой полученный HTTP-ответ (401,
 * 429, 500) — это уже ответ, повторять запрос незачем.
 */
async function postToWorker(url: string, body: string): Promise<RawResponse> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { status: r.status, text: await r.text() };
  } catch {
    // дальше — способ 2
  }

  try {
    const r = await fetch(url, { method: 'POST', body });
    return { status: r.status, text: await r.text() };
  } catch {
    // дальше — способ 3
  }

  return postViaXhr(url, body);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Собственно запрос к воркеру — адрес параметром, чтобы можно было
 * протестировать разбор ответа (200/401/429/битый JSON/обрыв сети) без
 * настоящего WORKER_URL, который до деплоя пуст намеренно.
 */
export async function loginTo(workerUrl: string, code: string): Promise<LoginResult> {
  if (!workerUrl) return { ok: false, reason: 'not_configured' };

  inFlight++;
  try {
    let res: RawResponse;
    try {
      res = await postToWorker(`${workerUrl}/login`, JSON.stringify({ code }));
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (res.status === 200) {
      const token = parseJson(res.text)?.token;
      if (typeof token !== 'string') return { ok: false, reason: 'network' };
      storeToken(token);
      return { ok: true };
    }

    if (res.status === 429) {
      const retry = parseJson(res.text)?.retryAfterMs;
      return { ok: false, reason: 'rate_limited', retryAfterMs: typeof retry === 'number' ? retry : 60_000 };
    }

    // Код верный, но воркер не смог подписать пропуск. Отдельная причина:
    // иначе это выглядело бы как «код не подошёл», и владелец сайта искал
    // бы проблему не там, где она есть (в секрете с ключом подписи).
    if (parseJson(res.text)?.error === 'signing_key_invalid') return { ok: false, reason: 'server' };

    return { ok: false, reason: 'invalid' };
  } finally {
    inFlight--;
  }
}

/**
 * Отправить код воркеру по HTTPS. При успехе токен уже сохранён в
 * localStorage — вызывающему коду достаточно проверить result.ok.
 */
export function login(code: string): Promise<LoginResult> {
  return loginTo(WORKER_URL, code);
}
