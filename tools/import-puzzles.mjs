// Конвертер PGN-задач Lichess в файл данных приложения.
//
// Запуск:
//   node tools/import-puzzles.mjs <файл.pgn> > src/data/puzzles-hanging.ts
//
// Каждая задача проверяется движком правил: валиден ли FEN, легален ли ход
// решения, действительно ли это взятие и можно ли взятую фигуру отыграть.
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

/** Первый SAN из текста хода: "22. Qxf1 {коммент} *" -> "Qxf1". */
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

/** Можно ли отыграть фигуру, вставшую на поле sq. */
function canRecapture(after, sq) {
  for (const [from, tos] of after.allDests()) {
    const piece = after.board.get(from);
    if (piece?.color !== after.turn) continue;
    if (tos.has(sq)) return true;
  }
  return false;
}

const games = parsePgn(text);
const out = [];
const rejected = [];
let recapturable = 0;

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

  const target = pos.board.get(move.to);
  if (!target) { fail(`ход ${san} не взятие`); continue; }

  const declared = g.tags.CapturedPiece;
  if (declared && declared !== target.role) {
    fail(`взята ${target.role}, в теге заявлена ${declared}`);
    continue;
  }

  const after = pos.clone();
  after.play(move);
  const free = !canRecapture(after, move.to);
  if (!free) recapturable++;

  out.push({
    id,
    fen: makeFen(pos.toSetup()),
    uci: makeUci(move),
    san: makeSan(pos, move),
    victim: target.role,
    free,
    themes: (g.tags.Themes || '').split(/\s+/).filter(Boolean),
    url: g.tags.Site || '',
  });
}

console.error(`Разобрано партий: ${games.length}`);
console.error(`Прошли проверку:  ${out.length}`);
console.error(`Отклонено:        ${rejected.length}`);
for (const r of rejected.slice(0, 10)) console.error(`  ${r.id}: ${r.why}`);
console.error(`Из принятых взятие можно отыграть у ${recapturable} задач.`);

const body = out
  .map(
    (p) => `  {
    id: '${p.id}',
    fen: '${p.fen}',
    uci: '${p.uci}',
    san: '${p.san}',
    victim: '${p.victim}',
    free: ${p.free},
    themes: [${p.themes.map((t) => `'${t}'`).join(', ')}],
  },`,
  )
  .join('\n');

process.stdout.write(`import type { Role } from 'chessops/types';

/**
 * Задачи «висящая фигура» из базы Lichess.
 *
 * Импортированы скриптом tools/import-puzzles.mjs и проверены движком правил:
 * FEN валиден, ход решения легален, это действительно взятие, а взятая фигура
 * совпадает с заявленной. Проверки повторяются автотестом
 * tests/puzzles-hanging.test.ts, поэтому битая задача не доедет до сборки.
 *
 * Поле free означает строгую «бесплатность»: взятую фигуру нельзя отыграть
 * вообще. Там, где free = false, взятие всё равно выигрывает материал,
 * но соперник может побить в ответ.
 */
export interface HangingPuzzle {
  /** Идентификатор задачи на Lichess: lichess.org/training/<id> */
  id: string;
  /** Позиция, ход белых. */
  fen: string;
  /** Единственный верный ход. */
  uci: string;
  san: string;
  /** Что берём. */
  victim: Role;
  /** Взятую фигуру нельзя отыграть. */
  free: boolean;
  themes: string[];
}

export const HANGING_PUZZLES: HangingPuzzle[] = [
${body}
];

export function puzzleUrl(p: HangingPuzzle): string {
  return \`https://lichess.org/training/\${p.id}\`;
}
`);
