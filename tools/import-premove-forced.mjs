// Конвертер JSON-задач «форсированное взятие» в файл данных приложения.
//
// Запуск:
//   node tools/import-premove-forced.mjs <файл.json> > src/data/premove-forced-imported.ts
//
// Формат входа — авторский JSON (schemaVersion 1.0, поле tasks[]), не PGN.
// Каждая задача проверяется движком правил независимо от полей источника:
// валиден ли FEN, легален ли и является ли взятием ожидаемый ход соперника,
// легален ли ответный ход после него и бьёт ли он на то же поле (recapture).
// FEN, SAN и UCI в выходе пересчитываются нами же, а не копируются из файла.
import { readFileSync } from 'node:fs';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { makeUci, parseUci } from 'chessops/util';

const file = process.argv[2];
if (!file) {
  console.error('Укажи путь к JSON');
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, 'utf8'));
const tasks = data.tasks ?? [];

const posFromFen = (fen) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

// Русские названия фигур для короткого авто-комментария: именительный
// падеж (кто берёт) и творительный (чем отвечаем).
const NOM = { pawn: 'Пешка', knight: 'Конь', bishop: 'Слон', rook: 'Ладья', queen: 'Ферзь', king: 'Король' };
const ACC = { pawn: 'пешку', knight: 'коня', bishop: 'слона', rook: 'ладью', queen: 'ферзя', king: 'короля' };
const INS = { pawn: 'пешкой', knight: 'конём', bishop: 'слоном', rook: 'ладьёй', queen: 'ферзём', king: 'королём' };

const out = [];
const rejected = [];

for (const t of tasks) {
  const fail = (why) => rejected.push({ id: t.id, why });
  if (t.mode !== 'premove_forced_recapture') { fail(`неизвестный режим ${t.mode}`); continue; }

  let pos;
  try {
    pos = posFromFen(t.startFen);
  } catch (e) {
    fail(`невалидный FEN: ${e.message}`);
    continue;
  }

  const userColor = t.orientation === 'white' ? 'white' : 'black';
  const opponentColor = userColor === 'white' ? 'black' : 'white';
  if (pos.turn !== opponentColor) { fail(`ход не за соперника (${pos.turn})`); continue; }

  const expectedMove = parseUci(t.expectedOpponentMove);
  if (!expectedMove || !pos.isLegal(expectedMove)) { fail(`expectedOpponentMove нелегален`); continue; }

  const capturedBefore = pos.board.get(expectedMove.to);
  if (!capturedBefore) { fail('expectedOpponentMove не взятие'); continue; }
  if (t.capturedPiece && capturedBefore.role !== t.capturedPiece) {
    fail(`взята ${capturedBefore.role}, заявлена ${t.capturedPiece}`);
    continue;
  }

  const after = pos.clone();
  after.play(expectedMove);

  const answerUciRaw = t.premove ?? t.acceptedPremoves?.[0];
  const answerMove = answerUciRaw ? parseUci(answerUciRaw) : null;
  if (!answerMove || !after.isLegal(answerMove)) { fail('ответный ход нелегален после ожидаемого'); continue; }
  // Форсированное взятие: ответ обязан отбить на то же поле.
  if (answerMove.to !== expectedMove.to) { fail('ответ бьёт не на то же поле'); continue; }

  const recapturer = after.board.get(answerMove.from);
  if (!recapturer) { fail('нет фигуры на исходном поле ответа'); continue; }
  if (t.recapturerPiece && recapturer.role !== t.recapturerPiece) {
    fail(`отвечает ${recapturer.role}, заявлено ${t.recapturerPiece}`);
    continue;
  }

  const capturer = pos.board.get(expectedMove.from);
  if (!capturer) { fail('нет фигуры на исходном поле ожидаемого хода'); continue; }
  if (t.capturerPiece && capturer.role !== t.capturerPiece) {
    fail(`бьёт ${capturer.role}, заявлено ${t.capturerPiece}`);
    continue;
  }

  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(after, answerMove);
  const sq = t.captureSquare ?? '';
  const comment = `${NOM[capturer.role]} берёт ${ACC[capturedBefore.role]}${sq ? ` на ${sq}` : ''}. Ответь premove ${INS[recapturer.role]}.`;

  out.push({
    id: t.id,
    fen: makeFen(pos.toSetup()),
    userColor,
    expectedUci: makeUci(expectedMove),
    expectedSan,
    answerUci: makeUci(answerMove),
    answerSan,
    comment,
  });
}

console.error(`Задач во входном файле: ${tasks.length}`);
console.error(`Прошли проверку:        ${out.length}`);
console.error(`Отклонено:               ${rejected.length}`);
for (const r of rejected.slice(0, 15)) console.error(`  ${r.id}: ${r.why}`);

const body = out
  .map(
    (p) => `  {
    id: '${p.id}',
    mode: 'forced-capture',
    fen: '${p.fen}',
    userColor: '${p.userColor}',
    expectedUci: '${p.expectedUci}',
    expectedSan: '${p.expectedSan}',
    answerUci: '${p.answerUci}',
    answerSan: '${p.answerSan}',
    shouldPremove: true,
    comment: '${p.comment.replace(/'/g, "\\'")}',
  },`,
  )
  .join('\n');

process.stdout.write(`import type { PremovePosition } from './premove-positions';

/**
 * Позиции «форсированное взятие», импортированные из набора реальных партий
 * Lichess скриптом tools/import-premove-forced.mjs.
 *
 * Каждая проверена движком правил независимо от полей источника: FEN валиден,
 * ожидаемый ход соперника легален и является взятием, ответный ход легален
 * после него и бьёт на то же поле. FEN, SAN и UCI пересчитаны нами, а не
 * скопированы из входного файла. Проверки повторяются автотестом
 * tests/premove-forced-imported.test.ts, поэтому битая позиция не доедет
 * до сборки.
 *
 * Используются вместе с рукописными позициями из premove-positions.ts —
 * там режим «Форсированное взятие» смешивает оба набора.
 */
export const PREMOVE_FORCED_IMPORTED: PremovePosition[] = [
${body}
];
`);
