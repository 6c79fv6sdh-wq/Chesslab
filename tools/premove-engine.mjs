// Node-обёртка над тем же бинарником Stockfish 18 Lite, что грузится в браузере
// (public/engine/stockfish-18-lite-single.{js,wasm}) — см. src/core/engine.ts.
//
// Файл движка — стандартная UMD-сборка stockfish.js (nmrugg/stockfish.js):
// при запуске `node stockfish-18-lite-single.js` напрямую (не как модуль)
// она сама поднимает readline-интерфейс поверх stdin/stdout и говорит по
// протоколу UCI. Ровно то же самое WASM-ядро, что и в браузере — никакой
// отдельной "серверной" сборки движка нет и не нужно.
//
// Единственная причина существования этого файла — прогнать реальный
// Stockfish оффлайн, один раз, при сборке пула позиций Premove (см.
// tools/build-premove-pool.mjs), а не дергать движок во время упражнения.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = join(__dirname, '..', 'public', 'engine', 'stockfish-18-lite-single.js');
const WASM_SRC = join(__dirname, '..', 'public', 'engine', 'stockfish-18-lite-single.wasm');

export const ENGINE_VERSION = 'Stockfish 18 Lite (single-thread WASM, offline Node)';

/**
 * Node трактует .js как ES-модуль из-за "type":"module" в package.json,
 * а движок написан в CommonJS-стиле (require/module.exports). Раскладка
 * .cjs рядом во временную папку решает это без правки самого движка —
 * который мы вообще не трогаем, чтобы не разойтись с браузерной сборкой.
 */
function stageCjs() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-engine-'));
  const jsDst = join(dir, 'stockfish.cjs');
  const wasmDst = join(dir, 'stockfish.wasm');
  copyFileSync(ENGINE_SRC, jsDst);
  copyFileSync(WASM_SRC, wasmDst);
  return jsDst;
}

export class NodeEngine {
  constructor() {
    if (!existsSync(ENGINE_SRC) || !existsSync(WASM_SRC)) {
      throw new Error(`движок не найден: ${ENGINE_SRC}`);
    }
    this.proc = null;
    this.buffer = [];
    this.listeners = [];
  }

  async start() {
    if (this.proc) return;
    const cjsPath = stageCjs();
    this.proc = spawn('node', [cjsPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    let carry = '';
    this.proc.stdout.on('data', (chunk) => {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        this.buffer.push(line);
        for (const l of [...this.listeners]) l(line);
      }
    });
    this.send('uci');
    await this.until(/uciok/);
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 64');
  }

  send(cmd) {
    this.proc.stdin.write(cmd + '\n');
  }

  until(re, timeoutMs = 60000) {
    for (const line of this.buffer) {
      const m = re.exec(line);
      if (m) return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`движок молчит: ${re}`));
      }, timeoutMs);
      const fn = (line) => {
        const m = re.exec(line);
        if (m) {
          clearTimeout(timer);
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

  /**
   * multipv строк анализа на заданной глубине. Формат строки — тот же,
   * что и в браузерном Engine.analyse(): score — от лица стороны хода
   * в переданном fen.
   */
  async analyse(fen, { depth = 18, multipv = 1 } = {}) {
    await this.start();
    this.send(`setoption name MultiPV value ${multipv}`);
    this.buffer.length = 0;
    this.send('ucinewgame');
    this.send('isready');
    await this.until(/readyok/);
    this.buffer.length = 0;
    this.send(`position fen ${fen}`);

    const lines = new Map();
    const onLine = (line) => {
      const m = /^info .*\bmultipv (\d+) .*?\bscore (cp|mate) (-?\d+) .*?\bpv (\S+)/.exec(line);
      if (!m) return;
      lines.set(Number(m[1]), {
        move: m[4],
        cp: m[2] === 'cp' ? Number(m[3]) : undefined,
        mate: m[2] === 'mate' ? Number(m[3]) : undefined,
      });
    };
    this.listeners.push(onLine);
    this.send(`go depth ${depth}`);
    try {
      await this.until(/^bestmove/, 120000);
    } finally {
      const i = this.listeners.indexOf(onLine);
      if (i >= 0) this.listeners.splice(i, 1);
    }
    return [...lines.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  }

  stop() {
    if (!this.proc) return;
    this.send('quit');
    this.proc.kill();
    this.proc = null;
  }
}
