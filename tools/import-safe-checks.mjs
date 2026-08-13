// Конвертер набора задач «безопасный шах» в файл данных приложения.
//
// Запуск:
//   node tools/import-safe-checks.mjs <файл.json> > src/data/puzzles-safe-check.ts
//
// Метаданным входного файла на слово не верим: каждая задача заново
// проверяется движком правил по определению упражнения. Пропускается только
// то, что прошло ВСЕ проверки:
//
//   1. FEN валиден и очередь хода совпадает с заявленной;
//   2. ход решения легален;
//   3. после него сопернику шах;
//   4. это не мат (иначе это уже другое упражнение — «мат в один ход»);
//   5. шахует именно сходившая фигура и она одна (не вскрытый и не двойной
//      шах: иначе «нельзя взять шахующую» теряет смысл);
//   6. эту фигуру нельзя взять в ответ ни одним легальным ходом, включая
//      взятие на проходе;
//   7. такой ход в позиции ровно один. Упражнение принимает единственный
//      ответ, и вторая столь же безопасная возможность означала бы, что
//      ученику засчитают ошибку за верное решение.
import { readFileSync } from 'node:fs';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseUci, makeUci, makeSquare, parseSquare } from 'chessops/util';

const file = process.argv[2];
if (!file) {
  console.error('Укажи путь к JSON с задачами');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
const tasks = raw.tasks ?? [];

/** Позиция из FEN или null, если FEN не разбирается. */
function positionOf(fen) {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const res = Chess.fromSetup(setup.unwrap());
  return res.isErr ? null : res.unwrap();
}

/** Все легальные ходы позиции. */
function legalMoves(pos) {
  const out = [];
  for (const [from, tos] of pos.allDests()) {
    for (const to of tos) {
      const promo = needsPromotion(pos, from, to) ? ['q', 'r', 'b', 'n'] : [undefined];
      for (const p of promo) out.push({ from, to, promotion: p });
    }
  }
  return out;
}

function needsPromotion(pos, from, to) {
  const piece = pos.board.get(from);
  if (piece?.role !== 'pawn') return false;
  const rank = to >> 3;
  return rank === 0 || rank === 7;
}

/**
 * Можно ли в этой позиции взять фигуру, стоящую на square. Отдельно
 * учитываем взятие на проходе: пешку, только что шагнувшую через клетку,
 * бьют не на её поле, а на поле «за спиной».
 */
function canCapture(pos, square) {
  const target = pos.board.get(square);
  for (const [from, tos] of pos.allDests()) {
    if (tos.has(square)) return true;
    if (
      target?.role === 'pawn' &&
      pos.epSquare !== undefined &&
      tos.has(pos.epSquare) &&
      pos.board.get(from)?.role === 'pawn'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Безопасный шах по определению упражнения? Возвращает причину отказа или
 * null, если ход подходит.
 */
function rejectReason(pos, move) {
  if (!pos.isLegal(move)) return 'ход нелегален';
  const after = pos.clone();
  after.play(move);
  if (!after.isCheck()) return 'нет шаха';
  if (after.isCheckmate()) return 'это мат';

  const checkers = after.ctx().checkers;
  if (checkers.size() !== 1) return 'двойной шах';
  if (checkers.first() !== move.to) return 'вскрытый шах: шахует не сходившая фигура';
  if (canCapture(after, move.to)) return 'шахующую фигуру можно взять';
  return null;
}

/** Все безопасные шахи позиции — для проверки единственности решения. */
function allSafeChecks(pos) {
  return legalMoves(pos).filter((m) => rejectReason(pos, m) === null);
}

const kept = [];
const skipped = [];

for (const t of tasks) {
  const pos = positionOf(t.fen);
  if (!pos) {
    skipped.push([t.id, 'FEN не разбирается']);
    continue;
  }
  const expectedTurn = t.sideToMove === 'w' ? 'white' : 'black';
  if (pos.turn !== expectedTurn) {
    skipped.push([t.id, `очередь хода ${pos.turn}, заявлено ${t.sideToMove}`]);
    continue;
  }

  const move = parseUci(t.solution.uci);
  if (!move) {
    skipped.push([t.id, 'ход решения не разбирается']);
    continue;
  }

  const reason = rejectReason(pos, move);
  if (reason) {
    skipped.push([t.id, reason]);
    continue;
  }

  const safe = allSafeChecks(pos);
  if (safe.length !== 1) {
    skipped.push([t.id, `безопасных шахов ${safe.length}, а не один: ${safe.map(makeUci).join(' ')}`]);
    continue;
  }

  const piece = pos.board.get(move.from);
  const san = makeSan(pos, move);

  kept.push({
    id: t.id,
    fen: t.fen,
    uci: makeUci(move),
    san,
    piece: piece.role,
    hasUnsafeAlternative: !!t.hasUnsafeCheckAlternative,
    gameId: t.source?.gameId ?? '',
  });
}

for (const [id, why] of skipped) console.error(`пропущена ${id}: ${why}`);
console.error(`\nвзято ${kept.length}, пропущено ${skipped.length} из ${tasks.length}`);

const lines = [];
lines.push(`import type { Role } from 'chessops/types';`);
lines.push('');
lines.push('/**');
lines.push(' * Задачи «безопасный шах»: шах, при котором шахующую фигуру нельзя взять.');
lines.push(' *');
lines.push(' * Позиции — из настоящих партий Lichess. Импортированы скриптом');
lines.push(' * tools/import-safe-checks.mjs, который заново проверяет каждую задачу');
lines.push(' * движком правил, а не полагается на метаданные исходного файла: ход');
lines.push(' * легален, даёт шах, это не мат, шахует именно сходившая фигура и она');
lines.push(' * одна, взять её нельзя (включая взятие на проходе), и такой ход в');
lines.push(' * позиции ровно один. Последнее важно: упражнение принимает единственный');
lines.push(' * ответ, и второй безопасный шах означал бы ошибку за верное решение.');
lines.push(' *');
lines.push(' * Те же проверки повторяет tests/puzzles-safe-check.test.ts, так что');
lines.push(' * битая задача не доедет до сборки.');
lines.push(' */');
lines.push('export interface SafeCheckPuzzle {');
lines.push('  /** Идентификатор внутри набора. */');
lines.push('  id: string;');
lines.push('  fen: string;');
lines.push('  /** Единственный безопасный шах в позиции. */');
lines.push('  uci: string;');
lines.push('  san: string;');
lines.push('  /** Чем шахуем — для разбора статистики по фигурам. */');
lines.push('  piece: Role;');
lines.push('  /** Есть ли в позиции шах-обманка, после которого фигуру бьют. */');
lines.push('  hasUnsafeAlternative: boolean;');
lines.push('  /** Партия-источник на Lichess: lichess.org/<id> */');
lines.push('  gameId: string;');
lines.push('}');
lines.push('');
lines.push('export const SAFE_CHECK_PUZZLES: SafeCheckPuzzle[] = [');
for (const p of kept) {
  lines.push('  {');
  lines.push(`    id: '${p.id}',`);
  lines.push(`    fen: '${p.fen}',`);
  lines.push(`    uci: '${p.uci}',`);
  lines.push(`    san: '${p.san}',`);
  lines.push(`    piece: '${p.piece}',`);
  lines.push(`    hasUnsafeAlternative: ${p.hasUnsafeAlternative},`);
  lines.push(`    gameId: '${p.gameId}',`);
  lines.push('  },');
}
lines.push('];');
lines.push('');

process.stdout.write(lines.join('\n'));
