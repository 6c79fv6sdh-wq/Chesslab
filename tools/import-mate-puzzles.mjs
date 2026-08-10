// Конвертер PGN-задач «мат в один ход» Lichess в файл данных приложения.
//
// Запуск:
//   node tools/import-mate-puzzles.mjs <файл.pgn> > src/data/puzzles-mate.ts
//
// Каждая задача проверяется движком правил: валиден ли FEN, легален ли ход
// решения и действительно ли после него на доске мат.
import { readFileSync } from 'node:fs';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan, makeSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

const file = process.argv[2];
if (!file) {
  console.error('Укажи путь к PGN');
  process.exit(1);
}

const text = readFileSync(file, 'utf8');

/** Разбор PGN на блоки: теги + ход решения. */
function parsePgn(src) {
  const games = [];
  let cur = null;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    const tag = /^\[(\w+)\s+"(.*)"\]$/.exec(line);
    if (tag) {
      if (!cur) cur = { tags: {}, moveText: '' };
      cur.tags[tag[1]] = tag[2];
      continue;
    }
    if (!line) continue;
    if (cur) {
      cur.moveText += ` ${line}`;
      if (line.includes('*') || /1-0|0-1|1\/2/.test(line)) {
        games.push(cur);
        cur = null;
      }
    }
  }
  if (cur) games.push(cur);
  return games;
}

/** Первый SAN из текста хода: "41. Qh8# {коммент} *" -> "Qh8#". */
function firstSan(moveText) {
  const cleaned = moveText.replace(/\{[^}]*\}/g, ' ').replace(/\d+\.(\.\.)?/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t === '*' || /^(1-0|0-1|1\/2-1\/2)$/.test(t)) continue;
    return t;
  }
  return null;
}

const posFromFen = (fen) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

const games = parsePgn(text);
const out = [];
const rejected = [];

for (const g of games) {
  const id = g.tags.PuzzleId || g.tags.Event || '?';
  const fen = g.tags.FEN;
  const san = firstSan(g.moveText);
  const fail = (why) => rejected.push({ id, why });

  if (!fen) { fail('нет FEN'); continue; }
  let pos;
  try { pos = posFromFen(fen); } catch (e) { fail(`невалидный FEN: ${e.message}`); continue; }
  if (!san) { fail('не нашёл ход решения'); continue; }

  const move = parseSan(pos, san);
  if (!move) { fail(`ход ${san} нелегален`); continue; }

  const after = pos.clone();
  after.play(move);
  if (!after.isCheckmate()) { fail(`после ${san} нет мата`); continue; }

  out.push({
    id,
    fen: makeFen(pos.toSetup()),
    uci: makeUci(move),
    san: makeSan(pos, move),
    themes: (g.tags.Themes || '').split(/\s+/).filter(Boolean),
  });
}

console.error(`Разобрано партий: ${games.length}`);
console.error(`Прошли проверку:  ${out.length}`);
console.error(`Отклонено:        ${rejected.length}`);
for (const r of rejected.slice(0, 10)) console.error(`  ${r.id}: ${r.why}`);

const body = out
  .map(
    (p) => `  {
    id: '${p.id}',
    fen: '${p.fen}',
    uci: '${p.uci}',
    san: '${p.san}',
    themes: [${p.themes.map((t) => `'${t}'`).join(', ')}],
  },`,
  )
  .join('\n');

process.stdout.write(`/**
 * Задачи «мат в один ход» из базы Lichess.
 *
 * Импортированы скриптом tools/import-mate-puzzles.mjs и проверены движком
 * правил: FEN валиден, ход решения легален и после него на доске мат.
 * Проверки повторяются автотестом tests/puzzles-mate.test.ts, поэтому битая
 * задача не доедет до сборки.
 */
export interface MatePuzzle {
  /** Идентификатор задачи на Lichess: lichess.org/training/<id> */
  id: string;
  /** Позиция, ход белых. */
  fen: string;
  /** Единственный верный ход — тот, что ставит мат. */
  uci: string;
  san: string;
  themes: string[];
}

export const MATE_PUZZLES: MatePuzzle[] = [
${body}
];

export function matePuzzleUrl(p: MatePuzzle): string {
  return \`https://lichess.org/training/\${p.id}\`;
}
`);
