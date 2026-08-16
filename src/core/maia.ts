/**
 * Maia в браузере поверх @lichess-org/zerofish.
 *
 * zerofish — сборка Lichess: lc0 и Stockfish в одном wasm-модуле (775 КБ).
 * lc0 здесь запускается с `nodes 1`, то есть без перебора вообще: ход
 * берётся прямо из политики сети. Именно так Maia и задумана — перебор
 * сделал бы её сильнее и «машиннее», а нам нужно ровно предсказание
 * человеческого хода.
 *
 * ВАЖНОЕ ОГРАНИЧЕНИЕ. Сборка собрана с pthreads, а значит требует
 * SharedArrayBuffer, а он доступен только на изолированной странице
 * (COOP/COEP). На GitHub Pages заголовки не выставить, поэтому изоляцию
 * включает service worker (см. public/coi.js). Если изоляции нет —
 * Maia недоступна, и это НЕ повод ронять партию: вызывающий код
 * проверяет `maiaAvailable()` и откатывается на Stockfish-ботов.
 */

import type { Zerofish, ZeroNet } from '@lichess-org/zerofish';

/** Есть ли на странице SharedArrayBuffer, без которого lc0 не стартует. */
export function crossOriginIsolated_(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
}

export function maiaAvailable(): boolean {
  return crossOriginIsolated_() && typeof WebAssembly === 'object';
}

function lc0Url(file: string): string {
  const base = new URL(import.meta.env.BASE_URL || './', document.baseURI);
  return new URL(`lc0/${file}`, base).href;
}

/** Кеш скачанных весов: сеть одна на всё приложение, тянуть её дважды незачем. */
const netCache = new Map<string, Promise<Uint8Array>>();

function fetchNet(file: string): Promise<Uint8Array> {
  let p = netCache.get(file);
  if (!p) {
    p = fetch(lc0Url(file))
      .then((r) => {
        if (!r.ok) throw new Error(`весы ${file}: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b));
    netCache.set(file, p);
  }
  return p;
}

let zf: Promise<Zerofish> | null = null;

async function engine(): Promise<Zerofish> {
  if (!maiaAvailable()) {
    throw new Error('нет изоляции страницы (SharedArrayBuffer недоступен)');
  }
  if (!zf) {
    zf = import('@lichess-org/zerofish').then((m) => m.default({ locator: lc0Url }));
    // Неудачную загрузку не кешируем: со второй попытки может получиться.
    zf.catch(() => {
      zf = null;
    });
  }
  return zf;
}

/** Прогреть wasm заранее, чтобы первый ход не ждал загрузки. */
export async function warmUpMaia(): Promise<void> {
  await engine();
}

export interface MaiaCandidate {
  move: string;
  score: number;
}

/**
 * Кандидаты Maia в позиции, от самого вероятного вниз.
 *
 * `multipv` берём с запасом: из этого списка бот потом сэмплирует по
 * температуре. Одного хода хватило бы только «честной» Maia.
 */
export async function maiaCandidates(
  fen: string,
  netFile: string,
  multipv = 5,
): Promise<MaiaCandidate[]> {
  const z = await engine();
  const net: ZeroNet = { key: netFile, fetch: () => fetchNet(netFile) };
  const res = await z.goZero({ fen }, { multipv, net, nodes: 1 });
  const lines = res.lines.at(-1) ?? [];
  const out: MaiaCandidate[] = [];
  for (const l of lines) {
    const move = l.moves?.[0];
    if (move) out.push({ move, score: l.score });
  }
  // Даже при multipv > 1 lc0 иногда отдаёт один вариант — тогда
  // сэмплировать не из чего, и остаётся bestmove.
  if (!out.length && res.bestmove && res.bestmove !== '(none)') {
    out.push({ move: res.bestmove, score: 0 });
  }
  return out;
}

/**
 * Оценка позиции Stockfish'ем — та самая «проверка качества хода».
 * Играет ботом не она: она нужна разбору и замеру реальной силы.
 */
export async function evaluate(fen: string, depth = 12): Promise<number | null> {
  const z = await engine();
  const res = await z.goFish({ fen }, { multipv: 1, by: { depth } });
  const line = (res.lines.at(-1) ?? [])[0];
  return line ? line.score : null;
}

export function disposeMaia(): void {
  if (!zf) return;
  const p = zf;
  zf = null;
  void p.then((z) => z.quit()).catch(() => undefined);
}
