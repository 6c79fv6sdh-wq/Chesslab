// Стенд проверки силы движка: матчи между разными значениями UCI_Elo.
//
// Запуск:
//   npm i --no-save stockfish
//   MT=50 G=12 node tools/engine-match.mjs
//
// Один экземпляр движка на процесс: два в одном процессе Node конфликтуют,
// поэтому сила переключается перед каждым ходом.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let initEngine;
try {
  initEngine = require('stockfish');
} catch {
  console.error('Нужен пакет движка: npm i --no-save stockfish');
  process.exit(1);
}

const { Chess } = await import('chessops/chess');
const { parseFen, makeFen, INITIAL_FEN } = await import('chessops/fen');
const { parseUci } = await import('chessops/util');
const { parseSan } = await import('chessops/san');

const mod = await initEngine('node_modules/stockfish/bin/stockfish-18-lite-single.js');
const buf = [];
mod.listener = (l) => buf.push(l);
const send = (c) => mod.sendCommand(c);
const wait = (re, ms = 30000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = buf.find((l) => re.test(l));
      if (hit) { clearInterval(iv); res(re.exec(hit)); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('таймаут ' + re)); }
    }, 15);
  });

send('uci');
await wait(/uciok/);
send('setoption name Threads value 1');
send('setoption name Hash value 16');

async function setElo(elo) {
  buf.length = 0;
  send('setoption name UCI_LimitStrength value true');
  send(`setoption name UCI_Elo value ${elo}`);
  send('isready');
  await wait(/readyok/);
}

async function bestMove(fen, movetime) {
  buf.length = 0;
  send(`position fen ${fen}`);
  send(`go movetime ${movetime}`);
  const m = await wait(/^bestmove (\S+)/);
  return m[1];
}

const posFromFen = (fen) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

const OPENINGS = [[], ['e4', 'e5'], ['d4', 'd5'], ['e4', 'c5'], ['Nf3', 'Nf6'], ['c4', 'e6']];
function startPos(i) {
  const pos = posFromFen(INITIAL_FEN);
  for (const san of OPENINGS[i % OPENINGS.length]) pos.play(parseSan(pos, san));
  return pos;
}

let gameIndex = 0;

async function playGame(whiteElo, blackElo, movetime, maxPlies = 160) {
  buf.length = 0;
  send('ucinewgame');
  send('isready');
  await wait(/readyok/);
  const pos = startPos(gameIndex++);
  let plies = 0;
  while (!pos.isEnd() && plies < maxPlies) {
    await setElo(pos.turn === 'white' ? whiteElo : blackElo);
    const uci = await bestMove(makeFen(pos.toSetup()), movetime);
    if (uci === '(none)') break;
    const mv = parseUci(uci);
    if (!mv || !pos.isLegal(mv)) throw new Error(`нелегальный ход ${uci}`);
    pos.play(mv);
    plies++;
  }
  if (pos.isCheckmate()) return pos.turn === 'white' ? 'black' : 'white';
  return 'draw';
}

async function match(label, eloA, eloB, games, movetime) {
  let score = 0, w = 0, d = 0, l = 0;
  for (let i = 0; i < games; i++) {
    const aWhite = i % 2 === 0;
    const res = await playGame(aWhite ? eloA : eloB, aWhite ? eloB : eloA, movetime);
    const aWon = (res === 'white' && aWhite) || (res === 'black' && !aWhite);
    if (res === 'draw') { score += 0.5; d++; }
    else if (aWon) { score += 1; w++; }
    else l++;
  }
  console.log(`${label}: ${score} из ${games} (+${w} =${d} -${l}) — ${((score / games) * 100).toFixed(0)}% очков`);
  return score / games;
}

const movetime = Number(process.env.MT || 50);
const games = Number(process.env.G || 12);
console.log(`Матчи по ${games} партий, ${movetime} мс на ход.`);
await match('Elo 2200 против Elo 1400', 2200, 1400, games, movetime);
await match('Elo 2200 против Elo 3000', 2200, 3000, games, movetime);
process.exit(0);
