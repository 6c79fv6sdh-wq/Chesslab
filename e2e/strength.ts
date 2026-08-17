/**
 * Стенд для замера реальной силы ботов.
 *
 * Считаем две вещи на каждого бота:
 *  • ACPL — средняя потеря в сантипешках относительно лучшего хода по
 *    Stockfish (глубина ACPL_DEPTH). Это и есть «насколько плохо играет».
 *  • Долю грубых зевков (потеря ≥ 300 сп) — по ним человек и узнаёт
 *    соперника своего уровня.
 *
 * Соперник в этих партиях — Stockfish с ограничением силы, одинаковый
 * для всех, чтобы позиции были сопоставимы.
 */
import makeZerofish, { type Zerofish } from '@lichess-org/zerofish';
import { BOTS, MAX_CANDIDATES, sampleByTemperature } from '../src/core/bots';
import { BEGINNER_PROFILE, chooseBlindMove } from '../src/core/blind-bot';
import { Engine } from '../src/core/engine';
import { INITIAL_FEN, fenOf, moveFromUci, posFromFen, uciOf, type Chess } from '../src/core/chess';

// Один движок на весь стенд: kind: 'blind' в проде тоже играет обычным
// (не Elo-ограниченным) Stockfish, только с малой глубиной поиска —
// используем тот же core/engine.ts, а не отдельный Stockfish из zerofish,
// чтобы замер бил по тому же коду, что действительно выполняется в игре.
let blindEngine: Engine | null = null;
async function engineForBlind(): Promise<Engine> {
  if (!blindEngine) {
    blindEngine = new Engine();
    await blindEngine.start();
    await blindEngine.setStrength(null);
  }
  return blindEngine;
}

const out = document.getElementById('out')!;
const log = (s: string) => {
  out.textContent += `${s}\n`;
  console.log(s);
};

const ACPL_DEPTH = 12;
const OPPONENT_ELO = 1500;

function lc0Url(file: string): string {
  return new URL(`/lc0/${file}`, document.baseURI).href;
}

let netBytes: Uint8Array | null = null;
async function net(file: string) {
  if (!netBytes) {
    netBytes = new Uint8Array(await (await fetch(lc0Url(file))).arrayBuffer());
  }
  return { key: file, fetch: async () => netBytes! };
}

/** Оценка позиции глазами Stockfish, всегда со стороны того, кто ходит. */
async function evalCp(zf: Zerofish, fen: string): Promise<number | null> {
  const r = await zf.goFish({ fen }, { multipv: 1, by: { depth: ACPL_DEPTH } });
  const line = (r.lines.at(-1) ?? [])[0];
  return line ? line.score : null;
}

interface BotStats {
  bot: string;
  rating: number | null;
  moves: number;
  acpl: number;
  blunderRate: number;
  score: number;
  games: number;
}

async function runBot(
  zf: Zerofish,
  botId: string,
  games: number,
  plies: number,
  tempOverride?: number,
): Promise<BotStats> {
  const base = BOTS.find((b) => b.id === botId)!;
  const def =
    tempOverride === undefined
      ? base
      : { ...base, temperature: tempOverride, name: `T=${tempOverride}` };
  const losses: number[] = [];
  let blunders = 0;
  let points = 0;

  for (let g = 0; g < games; g++) {
    let pos: Chess = posFromFen(INITIAL_FEN);
    const botIsWhite = g % 2 === 0;
    const moves: string[] = [];

    for (let ply = 0; ply < plies; ply++) {
      const botToMove = (pos.turn === 'white') === botIsWhite;
      const fen = fenOf(pos);
      let uci: string | null = null;

      if (botToMove) {
        // Лучший ход по Stockfish — эталон для подсчёта потери.
        const before = await evalCp(zf, fen);

        if (def.kind === 'maia') {
          const width = def.temperature ? (def.candidates ?? MAX_CANDIDATES) : 1;
          const r = await zf.goZero(
            { fen },
            { multipv: width, net: await net(def.net!), nodes: 1 },
          );
          const cands = (r.lines.at(-1) ?? [])
            .map((l) => ({ move: l.moves?.[0], score: l.score }))
            .filter((c): c is { move: string; score: number } => !!c.move);
          uci = sampleByTemperature(cands, def.temperature ?? 0, Math.random, width) ?? r.bestmove;
        } else if (def.kind === 'blind') {
          const engine = await engineForBlind();
          const mv = await chooseBlindMove(
            (f, opts) => engine.analyse(f, opts),
            pos,
            def.blindProfile ?? BEGINNER_PROFILE,
            Math.random,
          );
          uci = mv ? uciOf(mv) : null;
        } else {
          const r = await zf.goFish({ fen }, { multipv: 1, by: { depth: 6 }, level: 8 });
          uci = r.bestmove;
        }
        if (!uci || uci === '(none)') break;

        // Оценка после хода — с точки зрения соперника, поэтому минус.
        const next = pos.clone();
        try {
          const mv = moveFromUci(uci);
          if (!next.isLegal(mv)) break;
          next.play(mv);
        } catch {
          break;
        }
        const after = await evalCp(zf, fenOf(next));
        if (before !== null && after !== null) {
          const loss = Math.max(0, Math.min(1000, before - -after));
          losses.push(loss);
          if (loss >= 300) blunders++;
        }
      } else {
        const r = await zf.goFish({ fen }, { multipv: 1, by: { depth: 8 }, level: 20 });
        uci = r.bestmove;
        if (!uci || uci === '(none)') break;
      }

      try {
        const mv = moveFromUci(uci);
        if (!pos.isLegal(mv)) break;
        pos.play(mv);
        moves.push(uci);
      } catch {
        break;
      }
      if (pos.isEnd()) break;
    }

    // Итог: мат — очко, иначе по финальной оценке.
    if (pos.isCheckmate()) {
      const botLost = (pos.turn === 'white') === botIsWhite;
      points += botLost ? 0 : 1;
    } else {
      const final = await evalCp(zf, fenOf(pos));
      const fromBot = final === null ? 0 : (pos.turn === 'white') === botIsWhite ? final : -final;
      points += fromBot > 150 ? 1 : fromBot < -150 ? 0 : 0.5;
    }
    log(`  ${def.name}: партия ${g + 1}/${games}, ходов ${moves.length}`);
  }

  const acpl = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  return {
    bot: def.name,
    rating: def.rating,
    moves: losses.length,
    acpl: Math.round(acpl),
    blunderRate: losses.length ? Math.round((blunders / losses.length) * 1000) / 10 : 0,
    score: points,
    games,
  };
}

async function main() {
  const params = new URLSearchParams(location.search);
  const games = Number(params.get('games') ?? 2);
  const plies = Number(params.get('plies') ?? 40);
  const ids = (params.get('bots') ?? 'maia-novice,maia-1000,maia-1100,sf-1400').split(',');

  log(`Соперник: Stockfish (уровень ~${OPPONENT_ELO}), ACPL на глубине ${ACPL_DEPTH}`);
  const zf = await makeZerofish({ locator: lc0Url });
  const rows: BotStats[] = [];

  // Режим калибровки: гоняем ОДНУ сеть на разных температурах, чтобы
  // подобрать значения по замеру, а не на глаз.
  const temps = params.get('temps');
  if (temps) {
    for (const t of temps.split(',').map(Number)) {
      log(`\n=== температура ${t} ===`);
      rows.push(await runBot(zf, 'maia-1100', games, plies, t));
    }
    (window as unknown as { REPORT: BotStats[] }).REPORT = rows;
    log('\nDONE');
    return;
  }

  for (const id of ids) {
    log(`\n=== ${id} ===`);
    rows.push(await runBot(zf, id, games, plies));
  }
  (window as unknown as { REPORT: BotStats[] }).REPORT = rows;
  log(`\nDONE`);
}

main().catch((e) => {
  log(`FAILED: ${e}`);
  (window as unknown as { REPORT: unknown }).REPORT = { error: String(e) };
});
