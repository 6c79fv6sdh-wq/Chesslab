/**
 * Обёртка над Stockfish 18 Lite (однопоточная WASM-сборка).
 *
 * Однопоточная выбрана намеренно: многопоточная требует SharedArrayBuffer,
 * а для него нужны заголовки COOP/COEP, которых на GitHub Pages не выставить.
 *
 * Движок живёт в Web Worker, чтобы поиск не морозил интерфейс.
 * Файлы лежат в public/engine и подтягиваются при первом обращении:
 * в предзагрузку service worker их не кладём, иначе первое открытие
 * сайта весило бы 7 МБ. После первого использования они кешируются.
 *
 * Stockfish распространяется под GPLv3, см. public/engine/LICENSE-stockfish.txt.
 */

export const ENGINE_NAME = 'Stockfish 18 Lite';

/** Границы UCI_Elo у этой сборки. */
export const ELO_MIN = 1320;
export const ELO_MAX = 3190;

export function clampElo(elo: number): number {
  return Math.min(ELO_MAX, Math.max(ELO_MIN, Math.round(elo)));
}

export interface SearchLimits {
  /** Сколько миллисекунд думать. */
  movetimeMs?: number;
  /** Ограничение по глубине вместо времени. */
  depth?: number;
}

type Listener = (line: string) => void;

function engineUrl(): URL {
  // База считается от документа, чтобы работало и в подкаталоге GitHub Pages.
  const base = new URL(import.meta.env.BASE_URL || './', document.baseURI);
  return new URL('engine/stockfish-18-lite-single.js', base);
}

export class Engine {
  private worker: Worker | null = null;
  private listeners: Listener[] = [];
  private buffer: string[] = [];
  private booting: Promise<void> | null = null;
  private currentElo: number | null = null;

  /** Готов ли движок принимать команды. */
  get ready(): boolean {
    return this.worker !== null && this.booting === null;
  }

  /** Загружен ли WASM (первый вызов тянет 7 МБ). */
  async start(): Promise<void> {
    if (this.worker && !this.booting) return;
    if (this.booting) return this.booting;

    this.booting = (async () => {
      const worker = new Worker(engineUrl());
      this.worker = worker;
      worker.onmessage = (e: MessageEvent) => {
        const line = typeof e.data === 'string' ? e.data : String(e.data);
        this.buffer.push(line);
        if (this.buffer.length > 400) this.buffer.splice(0, 200);
        for (const l of [...this.listeners]) l(line);
      };
      this.send('uci');
      await this.until(/uciok/, 60000);
      this.send('setoption name Threads value 1');
      this.send('setoption name Hash value 16');
      this.send('isready');
      await this.until(/readyok/, 60000);
    })();

    try {
      await this.booting;
    } finally {
      this.booting = null;
    }
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  /**
   * Ждёт строку по образцу. Сначала смотрит уже полученные строки:
   * ответ движка может опередить подписку.
   */
  private until(re: RegExp, timeoutMs = 30000): Promise<RegExpExecArray> {
    for (const line of this.buffer) {
      const m = re.exec(line);
      if (m) return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        off();
        reject(new Error(`движок молчит: ${re}`));
      }, timeoutMs);
      const fn: Listener = (line) => {
        const m = re.exec(line);
        if (m) {
          window.clearTimeout(timer);
          off();
          resolve(m);
        }
      };
      const off = () => {
        const i = this.listeners.indexOf(fn);
        if (i >= 0) this.listeners.splice(i, 1);
      };
      this.listeners.push(fn);
    });
  }

  /** elo = null — играть в полную силу. */
  async setStrength(elo: number | null): Promise<void> {
    await this.start();
    if (this.currentElo === elo) return;
    this.buffer.length = 0;
    if (elo === null) {
      this.send('setoption name UCI_LimitStrength value false');
    } else {
      this.send('setoption name UCI_LimitStrength value true');
      this.send(`setoption name UCI_Elo value ${clampElo(elo)}`);
    }
    this.send('isready');
    await this.until(/readyok/);
    this.currentElo = elo;
  }

  async newGame(): Promise<void> {
    await this.start();
    this.buffer.length = 0;
    this.send('ucinewgame');
    this.send('isready');
    await this.until(/readyok/);
  }

  /** Лучший ход в позиции. Возвращает UCI либо null, если ходов нет. */
  async bestMove(fen: string, limits: SearchLimits = {}): Promise<string | null> {
    await this.start();
    this.buffer.length = 0;
    this.send(`position fen ${fen}`);
    const limit = limits.depth ? `depth ${limits.depth}` : `movetime ${limits.movetimeMs ?? 100}`;
    this.send(`go ${limit}`);
    const m = await this.until(/^bestmove (\S+)/, 60000);
    const uci = m[1];
    return uci === '(none)' ? null : uci;
  }

  /** Прервать текущий поиск. */
  stop(): void {
    this.send('stop');
  }

  destroy(): void {
    try {
      this.send('quit');
    } catch {
      // Воркер мог уже умереть — это не повод падать.
    }
    this.worker?.terminate();
    this.worker = null;
    this.listeners = [];
    this.buffer = [];
    this.currentElo = null;
  }
}

/**
 * Один общий экземпляр на приложение: 7 МБ WASM незачем грузить дважды.
 */
let shared: Engine | null = null;

export function sharedEngine(): Engine {
  if (!shared) shared = new Engine();
  return shared;
}

export function engineSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
}
