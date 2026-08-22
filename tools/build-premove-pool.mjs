// Офлайн-сборщик пула Premove: единственное место, где во время РАЗРАБОТКИ
// (не во время упражнения — это отдельное явное требование ТЗ) дергается
// Stockfish. Прогоняет tools/premove-candidates.json через:
//   1) структурные проверки chessops (легальность, тип хода, уникальность
//      взятия) — независимо от src/data/premove-validator.ts, тем же
//      способом, что и существующий tools/import-premove-forced.mjs;
//   2) числовые пороги — СПИСАНЫ с src/data/premove-validator.ts построчно,
//      менять только вместе.
// Результат: src/data/premove-pool.ts (готовые задания с метаданными
// источника и оценками) + отчёт об отклонённых кандидатах в stdout.
//
// Запуск: node tools/build-premove-pool.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { makeUci, parseUci, opposite } from 'chessops/util';
import { NodeEngine, ENGINE_VERSION } from './premove-engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPTH = 20;

// --- Пороги. Идентичны src/data/premove-validator.ts.
const FORCED_CAPTURE_ALT_MARGIN_PAWNS = 1.5;
const FORCED_CAPTURE_NOT_FORCED_GAP_PAWNS = 0.3;
const FORCED_CAPTURE_DISASTER_PAWNS = 1;
const SAFE_MAX_LOSS_PAWNS = 0.4;
const UNSAFE_MIN_LOSS_PAWNS = 1.5;
const UNSAFE_ALT_TOP_N = 3;
const UNSAFE_ALT_MAX_GAP_PAWNS = 1.0;

const posFromFen = (fen) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
const fenOf = (pos) => makeFen(pos.toSetup());
const uciOf = (m) => makeUci(m);

function isSpecialMove(pos, move) {
  const piece = pos.board.get(move.from);
  if (!piece) return false;
  if (move.promotion) return true;
  if (piece.role === 'king' && Math.abs((move.to & 7) - (move.from & 7)) === 2) return true;
  if (piece.role === 'pawn') {
    const isDiagonal = (move.from & 7) !== (move.to & 7);
    if (isDiagonal && !pos.board.get(move.to)) return true; // en passant
  }
  return false;
}

function isCaptureMove(pos, move) {
  if (pos.board.get(move.to)) return true;
  const piece = pos.board.get(move.from);
  return piece?.role === 'pawn' && (move.from & 7) !== (move.to & 7);
}

function allLegalMoves(pos) {
  const out = [];
  for (const [from, tos] of pos.allDests()) {
    for (const to of tos) {
      const piece = pos.board.get(from);
      if (piece?.role === 'pawn' && (to >> 3 === 7 || to >> 3 === 0)) {
        for (const promotion of ['queen', 'knight', 'rook', 'bishop']) out.push({ from, to, promotion });
      } else out.push({ from, to });
    }
  }
  return out;
}

function lineScoreCp(line) {
  if (!line) return 0;
  if (line.mate !== undefined) return line.mate > 0 ? 100000 - line.mate : -100000 - line.mate;
  return line.cp ?? 0;
}
function scoreForColor(line, posTurn, perspective) {
  const cp = lineScoreCp(line);
  return (posTurn === perspective ? cp : -cp) / 100;
}

// --- Кэш анализа: fen -> lines. Считаем каждую позицию максимум один раз.
const engine = new NodeEngine();
const cache = new Map();
async function linesAt(fen, multipv = 5) {
  if (cache.has(fen)) return cache.get(fen);
  const lines = await engine.analyse(fen, { depth: DEPTH, multipv });
  cache.set(fen, lines);
  return lines;
}

function describeForcedCapture(userColor, expectedSan, answerSan) {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Ожидается ${expectedSan}. Поставь ответное взятие заранее: ${answerSan}.`;
}
function describeSafeUnsafe(userColor, expectedSan, answerSan, verdictText) {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Ожидается ${expectedSan}. Предполагаемый premove: ${answerSan}. ${verdictText}`;
}
function safeVerdict() {
  return 'Безопасно: при любом другом ходе соперника premove либо не исполнится, либо не потеряет больше 0,4 пешки.';
}
function unsafeVerdict(dangerousSan) {
  return `Опасно: после ${dangerousSan} premove остаётся легальным и проигрывает не меньше 1,5 пешки.`;
}
function describeCancelKeep(userColor, expectedSan, answerSan) {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Премув уже поставлен. Соперник сыграет ожидаемое ${expectedSan} — premove ${answerSan} можно оставить.`;
}
function describeCancelRemove(userColor, unexpectedSan, answerSan) {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Премув уже поставлен. Соперник сыграл неожиданно: ${unexpectedSan}. Premove ${answerSan} снимать было надо.`;
}

async function validateForcedCapture(c) {
  const reasons = [];
  const pos = posFromFen(c.fen);
  if (pos.isCheck()) return { rejected: 'в исходной позиции уже шах — исключено на первом этапе' };
  const opponent = opposite(c.userColor);
  if (pos.turn !== opponent) return { rejected: `ход в fen не за соперника (${pos.turn})` };

  const expectedMove = parseUci(c.expectedUci);
  if (!expectedMove || !pos.isLegal(expectedMove)) return { rejected: 'ожидаемый ход нелегален' };
  if (isSpecialMove(pos, expectedMove)) return { rejected: 'ожидаемый ход — рокировка/превращение/en passant' };
  if (!isCaptureMove(pos, expectedMove)) return { rejected: 'ожидаемый ход не является взятием' };

  const after = pos.clone();
  after.play(expectedMove);
  const answerMove = parseUci(c.answerUci);
  if (!answerMove || !after.isLegal(answerMove)) return { rejected: 'ответный ход нелегален после ожидаемого' };
  if (isSpecialMove(after, answerMove)) return { rejected: 'ответный ход — рокировка/превращение/en passant' };
  if (answerMove.to !== expectedMove.to) return { rejected: 'ответ бьёт не на то же поле — не форсированное взятие' };

  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(after, answerMove);

  const rootLines = await linesAt(c.fen, 5);
  const bestLine = rootLines[0];
  const bestScore = scoreForColor(bestLine, pos.turn, opponent);
  if (bestLine.move !== c.expectedUci) {
    const expLine = rootLines.find((l) => l.move === c.expectedUci);
    const expScore = expLine ? scoreForColor(expLine, pos.turn, opponent) : -Infinity;
    if (bestScore - expScore > FORCED_CAPTURE_NOT_FORCED_GAP_PAWNS) {
      return { rejected: `ожидаемый ход не лучший у соперника (отстаёт на ${(bestScore - expScore).toFixed(2)})` };
    }
  }
  const second = rootLines[1];
  if (second && second.move !== c.expectedUci) {
    const gap = bestScore - scoreForColor(second, pos.turn, opponent);
    if (gap < FORCED_CAPTURE_NOT_FORCED_GAP_PAWNS) {
      return { rejected: 'у соперника есть равноценное продолжение — не форсировано' };
    }
  }

  const altRecaptures = allLegalMoves(after).filter(
    (m) => m.to === expectedMove.to && !(m.from === answerMove.from && m.to === answerMove.to),
  );
  if (altRecaptures.length > 0) {
    const afterLines = await linesAt(fenOf(after), 5);
    const answerLine = afterLines.find((l) => l.move === c.answerUci);
    const answerScore = answerLine
      ? scoreForColor(answerLine, after.turn, c.userColor)
      : scoreForColor(afterLines[0], after.turn, c.userColor);
    for (const alt of altRecaptures) {
      const altUci = uciOf(alt);
      const altLine = afterLines.find((l) => l.move === altUci);
      const altScore = altLine ? scoreForColor(altLine, after.turn, c.userColor) : answerScore;
      if (answerScore - altScore < FORCED_CAPTURE_ALT_MARGIN_PAWNS) {
        return { rejected: `правильное взятие не единственно: ${altUci} отстаёт на ${(answerScore - altScore).toFixed(2)}` };
      }
    }
  }

  const afterAnswer = after.clone();
  afterAnswer.play(answerMove);
  const afterAnswerLines = await linesAt(fenOf(afterAnswer), 3);
  const evalAfterAnswerPawns = scoreForColor(afterAnswerLines[0], afterAnswer.turn, c.userColor);
  if (evalAfterAnswerPawns < -FORCED_CAPTURE_DISASTER_PAWNS) {
    return { rejected: `ответ ведёт к немедленной катастрофе (${evalAfterAnswerPawns.toFixed(2)})` };
  }

  void reasons;
  return {
    task: {
      id: c.id,
      mode: 'forced-capture',
      fen: c.fen,
      userColor: c.userColor,
      expectedUci: c.expectedUci,
      expectedSan,
      answerUci: c.answerUci,
      answerSan,
      shouldPremove: true,
      comment: describeForcedCapture(c.userColor, expectedSan, answerSan),
      source: c.source,
      evalMeta: { engine: ENGINE_VERSION, depth: DEPTH },
      evalPawns: Number(evalAfterAnswerPawns.toFixed(2)),
    },
  };
}

async function branchLossPawns(beforeFen, forcedMove, userColor) {
  const beforePos = posFromFen(beforeFen);
  const bestLines = await linesAt(beforeFen, 3);
  const bestScore = scoreForColor(bestLines[0], beforePos.turn, userColor);
  const after = beforePos.clone();
  after.play(forcedMove);
  const forcedLines = await linesAt(fenOf(after), 3);
  const forcedScore = scoreForColor(forcedLines[0], after.turn, userColor);
  return bestScore - forcedScore;
}

async function validateSafeUnsafe(c) {
  const pos = posFromFen(c.fen);
  if (pos.isCheck()) return { rejected: 'в исходной позиции уже шах — исключено на первом этапе' };
  const opponent = opposite(c.userColor);
  if (pos.turn !== opponent) return { rejected: 'ход в fen не за соперника' };

  const expectedMove = parseUci(c.expectedUci);
  const answerMove = parseUci(c.answerUci);
  if (!expectedMove || !pos.isLegal(expectedMove)) return { rejected: 'ожидаемый ход нелегален' };
  if (isSpecialMove(pos, expectedMove)) return { rejected: 'ожидаемый ход — исключённый тип' };
  const after = pos.clone();
  after.play(expectedMove);
  if (!answerMove || !after.isLegal(answerMove)) return { rejected: 'premove нелегален после ожидаемого хода' };
  if (isSpecialMove(after, answerMove)) return { rejected: 'premove — исключённый тип хода' };

  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(after, answerMove);

  const rootLines = await linesAt(c.fen, 8);
  const bestScore = scoreForColor(rootLines[0], pos.turn, opponent);

  const branches = allLegalMoves(pos)
    .filter((m) => uciOf(m) !== c.expectedUci)
    .map((m) => {
      const afterB = pos.clone();
      afterB.play(m);
      return { uci: uciOf(m), afterFen: fenOf(afterB), premoveLegal: afterB.isLegal(answerMove) };
    });

  const expectedLoss = await branchLossPawns(fenOf(after), answerMove, c.userColor);
  if (expectedLoss > SAFE_MAX_LOSS_PAWNS) {
    return { rejected: `premove теряет ${expectedLoss.toFixed(2)} уже на ожидаемой ветке` };
  }

  let worstNaturalUnsafe = null;
  let anyGrayZone = false;
  let allOtherSafe = true;

  for (const b of branches) {
    if (!b.premoveLegal) continue;
    const lossPawns = await branchLossPawns(b.afterFen, answerMove, c.userColor);
    const rank = rootLines.findIndex((l) => l.move === b.uci);
    const rankScore = rank >= 0 ? scoreForColor(rootLines[rank], pos.turn, opponent) : -Infinity;
    const natural = rank >= 0 && (rank < UNSAFE_ALT_TOP_N || bestScore - rankScore <= UNSAFE_ALT_MAX_GAP_PAWNS);
    if (lossPawns > SAFE_MAX_LOSS_PAWNS) {
      allOtherSafe = false;
      if (lossPawns >= UNSAFE_MIN_LOSS_PAWNS && natural) {
        if (!worstNaturalUnsafe || lossPawns > worstNaturalUnsafe.loss) worstNaturalUnsafe = { uci: b.uci, loss: lossPawns };
      } else {
        anyGrayZone = true;
      }
    }
  }

  if (allOtherSafe) {
    return {
      task: {
        id: c.id,
        mode: 'safe-unsafe',
        fen: c.fen,
        userColor: c.userColor,
        expectedUci: c.expectedUci,
        expectedSan,
        answerUci: c.answerUci,
        answerSan,
        shouldPremove: true,
        comment: describeSafeUnsafe(c.userColor, expectedSan, answerSan, safeVerdict()),
        source: c.source,
        evalMeta: { engine: ENGINE_VERSION, depth: DEPTH },
        evalPawns: Number((-expectedLoss).toFixed(2)),
      },
    };
  }
  if (worstNaturalUnsafe && !anyGrayZone) {
    const dangerMove = parseUci(worstNaturalUnsafe.uci);
    const dangerSan = makeSan(pos, dangerMove);
    return {
      task: {
        id: c.id,
        mode: 'safe-unsafe',
        fen: c.fen,
        userColor: c.userColor,
        expectedUci: c.expectedUci,
        expectedSan,
        answerUci: c.answerUci,
        answerSan,
        shouldPremove: false,
        dangerousUci: worstNaturalUnsafe.uci,
        dangerousSan: dangerSan,
        comment: describeSafeUnsafe(c.userColor, expectedSan, answerSan, unsafeVerdict(dangerSan)),
        source: c.source,
        evalMeta: { engine: ENGINE_VERSION, depth: DEPTH },
        evalPawns: Number((-worstNaturalUnsafe.loss).toFixed(2)),
      },
    };
  }
  return { rejected: 'серая зона 0.4–1.5 или unsafe доказан неестественным ходом' };
}

/** Из forced-capture-совместимой базовой позиции строит пару cancel-заданий:
 * «оставить» (реально играется expectedUci) и «снять» (играется natural
 * альтернатива из топа движка, если она реально наказывает неснятый premove). */
async function buildCancelPair(c) {
  const pos = posFromFen(c.fen);
  if (pos.isCheck()) return { rejectedKeep: 'шах в исходной позиции', rejectedRemove: 'шах в исходной позиции' };
  const opponent = opposite(c.userColor);
  if (pos.turn !== opponent) return { rejectedKeep: 'ход не за соперника', rejectedRemove: 'ход не за соперника' };
  const expectedMove = parseUci(c.expectedUci);
  const answerMove = parseUci(c.answerUci);
  if (!expectedMove || !pos.isLegal(expectedMove) || isSpecialMove(pos, expectedMove)) {
    return { rejectedKeep: 'ожидаемый ход нелегален/исключён', rejectedRemove: 'ожидаемый ход нелегален/исключён' };
  }
  const afterExpected = pos.clone();
  afterExpected.play(expectedMove);
  if (!answerMove || !afterExpected.isLegal(answerMove)) {
    return { rejectedKeep: 'premove нелегален после ожидаемого', rejectedRemove: 'premove нелегален после ожидаемого' };
  }
  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(afterExpected, answerMove);

  const keep = {
    id: `${c.id}-keep`,
    mode: 'cancel',
    fen: c.fen,
    userColor: c.userColor,
    expectedUci: c.expectedUci,
    expectedSan,
    answerUci: c.answerUci,
    answerSan,
    correctAction: 'keep',
    comment: describeCancelKeep(c.userColor, expectedSan, answerSan),
    source: c.source,
    evalMeta: { engine: ENGINE_VERSION, depth: DEPTH },
  };

  // Ищем «неожиданный» ход СРЕДИ ВСЕХ легальных ходов соперника (не только
  // top-N движка) — как и validateSafeUnsafe: важна не топовость хода
  // самого по себе, а то, что после него premove остаётся легальным
  // (иначе он и так автоматически отбрасывается — снимать нечего) и
  // серьёзно наказывается. «Естественность» (топ-3 или в пределах 1.0)
  // проверяется отдельно, чтобы не наказывать за ход, который ни один
  // живой соперник не сыграет.
  const rootLines = await linesAt(c.fen, 8);
  const bestScore = scoreForColor(rootLines[0], pos.turn, opponent);
  const branches = allLegalMoves(pos).filter((m) => uciOf(m) !== c.expectedUci);

  let worst = null;
  let rejectedRemove = 'не нашлось естественной опасной альтернативы соперника, где premove остаётся легален';
  for (const m of branches) {
    if (isSpecialMove(pos, m)) continue;
    const uci = uciOf(m);
    const afterUnexpected = pos.clone();
    afterUnexpected.play(m);
    if (!afterUnexpected.isLegal(answerMove)) continue; // авто-отброшен — снимать нечего

    const rank = rootLines.findIndex((l) => l.move === uci);
    const rankScore = rank >= 0 ? scoreForColor(rootLines[rank], pos.turn, opponent) : -Infinity;
    const natural = rank >= 0 && (rank < UNSAFE_ALT_TOP_N || bestScore - rankScore <= UNSAFE_ALT_MAX_GAP_PAWNS);
    if (!natural) continue;

    // Та же формула, что и в validateSafeUnsafe: потеря — это разница между
    // лучшим доступным ходом пользователя в этой ветке и тем, что реально
    // получается, если его вынуждают сыграть premove. Раньше здесь стояла
    // другая, ошибочная формула (абсолютная оценка после premove вместо
    // разницы с лучшим ходом) — она не находила ни одной ветки, хотя
    // validateSafeUnsafe своей (верной) формулой находил.
    const lossPawns = await branchLossPawns(fenOf(afterUnexpected), answerMove, c.userColor);
    if (lossPawns >= UNSAFE_MIN_LOSS_PAWNS && (!worst || lossPawns > worst.lossPawns)) {
      worst = { uci, lossPawns, unexpectedMove: m };
    }
  }

  let remove = null;
  if (worst) {
    const unexpectedSan = makeSan(pos, worst.unexpectedMove);
    remove = {
      id: `${c.id}-remove`,
      mode: 'cancel',
      fen: c.fen,
      userColor: c.userColor,
      expectedUci: c.expectedUci,
      expectedSan,
      answerUci: c.answerUci,
      answerSan,
      unexpectedUci: worst.uci,
      unexpectedSan,
      correctAction: 'remove',
      comment: describeCancelRemove(c.userColor, unexpectedSan, answerSan),
      source: c.source,
      evalMeta: { engine: ENGINE_VERSION, depth: DEPTH },
      evalPawns: Number((-worst.lossPawns).toFixed(2)),
    };
  }

  return { keep, remove, rejectedRemove: remove ? undefined : rejectedRemove };
}

/**
 * Дедуп по позиции — НО с поправкой на режим «Отмена»: пара «оставить» /
 * «снять» одной и той же базовой позиции ОБЯЗАНА иметь одинаковый fen —
 * это не случайное совпадение, а суть задания: пользователь решает ДО
 * хода соперника, когда на доске ещё нет разницы между «оставить» и
 * «снять». Поэтому дубликатом считаем совпадение fen только МЕЖДУ разными
 * базовыми кандидатами, а не внутри одной cancel-пары.
 */
function dedup(tasks) {
  const seen = []; // { sig, baseId }
  const out = [];
  const rejected = [];
  const sigOf = (fen) => fen.split(' ').slice(0, 4).join(' ');
  const mirrorOf = (fen) => {
    const [board, turn, castle, ep] = fen.split(' ');
    const mBoard = board.split('/').map((r) => r.split('').reverse().join('')).join('/');
    const mEp = ep === '-' ? '-' : `${String.fromCharCode(219 - ep.charCodeAt(0))}${ep[1]}`;
    return [mBoard, turn, castle, mEp].join(' ');
  };
  const baseIdOf = (id) => id.replace(/-(keep|remove)$/, '');
  for (const t of tasks) {
    const sig = sigOf(t.fen);
    const mirror = mirrorOf(t.fen);
    const base = baseIdOf(t.id);
    const isDup = seen.some((s) => (s.sig === sig || s.sig === mirror) && s.baseId !== base);
    if (isDup) {
      rejected.push({ id: t.id, why: 'дубликат/зеркальный дубликат уже включённой позиции' });
      continue;
    }
    seen.push({ sig, baseId: base });
    out.push(t);
  }
  return { out, rejected };
}

async function main() {
  const data = JSON.parse(readFileSync(join(__dirname, 'premove-candidates.json'), 'utf8'));
  const candidates = data.candidates;

  const forcedResults = [];
  const safeUnsafeResults = [];
  const cancelResults = [];
  const rejectedLog = [];

  for (const c of candidates) {
    const fc = await validateForcedCapture(c);
    if (fc.task) forcedResults.push(fc.task);
    else rejectedLog.push({ id: c.id, mode: 'forced-capture', why: fc.rejected });

    const su = await validateSafeUnsafe(c);
    if (su.task) safeUnsafeResults.push(su.task);
    else rejectedLog.push({ id: c.id, mode: 'safe-unsafe', why: su.rejected });

    const cx = await buildCancelPair(c);
    if (cx.keep) cancelResults.push(cx.keep);
    else rejectedLog.push({ id: `${c.id}-keep`, mode: 'cancel', why: cx.rejectedKeep });
    if (cx.remove) cancelResults.push(cx.remove);
    else rejectedLog.push({ id: `${c.id}-remove`, mode: 'cancel', why: cx.rejectedRemove });
  }

  const { out: forcedFinal, rejected: forcedDup } = dedup(forcedResults);
  const { out: safeUnsafeFinal, rejected: suDup } = dedup(safeUnsafeResults);
  const { out: cancelFinal, rejected: cxDup } = dedup(cancelResults);
  rejectedLog.push(...forcedDup, ...suDup, ...cxDup);

  console.log(`\n=== Отчёт сборки пула Premove (движок: ${ENGINE_VERSION}, глубина ${DEPTH}) ===`);
  console.log(`Базовых кандидатов: ${candidates.length}`);
  console.log(`\nОтклонено (${rejectedLog.length}):`);
  for (const r of rejectedLog) console.log(`  [${r.mode}] ${r.id}: ${r.why}`);
  console.log(`\nПрошло:`);
  console.log(`  forced-capture: ${forcedFinal.length}`);
  console.log(`  safe-unsafe: ${safeUnsafeFinal.length} (safe: ${safeUnsafeFinal.filter((t) => t.shouldPremove).length}, unsafe: ${safeUnsafeFinal.filter((t) => !t.shouldPremove).length})`);
  console.log(`  cancel: ${cancelFinal.length} (keep: ${cancelFinal.filter((t) => t.correctAction === 'keep').length}, remove: ${cancelFinal.filter((t) => t.correctAction === 'remove').length})`);

  const body = renderPoolFile({ forced: forcedFinal, safeUnsafe: safeUnsafeFinal, cancel: cancelFinal });
  writeFileSync(join(__dirname, '..', 'src', 'data', 'premove-pool.ts'), body);
  console.log(`\nЗаписано: src/data/premove-pool.ts`);

  engine.stop();
}

function jsStr(s) {
  return JSON.stringify(s);
}

function renderTask(t) {
  const lines = [
    `  {`,
    `    id: ${jsStr(t.id)},`,
    `    mode: ${jsStr(t.mode)},`,
    `    fen: ${jsStr(t.fen)},`,
    `    userColor: ${jsStr(t.userColor)},`,
    `    expectedUci: ${jsStr(t.expectedUci)},`,
    `    expectedSan: ${jsStr(t.expectedSan)},`,
    `    answerUci: ${jsStr(t.answerUci)},`,
    `    answerSan: ${jsStr(t.answerSan)},`,
  ];
  if (t.mode === 'cancel') {
    lines.push(`    correctAction: ${jsStr(t.correctAction)},`);
    if (t.unexpectedUci) lines.push(`    unexpectedUci: ${jsStr(t.unexpectedUci)},`);
    if (t.unexpectedSan) lines.push(`    unexpectedSan: ${jsStr(t.unexpectedSan)},`);
  } else {
    lines.push(`    shouldPremove: ${t.shouldPremove},`);
    if (t.dangerousUci) lines.push(`    dangerousUci: ${jsStr(t.dangerousUci)},`);
    if (t.dangerousSan) lines.push(`    dangerousSan: ${jsStr(t.dangerousSan)},`);
  }
  lines.push(`    comment: ${jsStr(t.comment)},`);
  lines.push(`    source: {`);
  lines.push(`      white: ${jsStr(t.source.white)},`);
  lines.push(`      black: ${jsStr(t.source.black)},`);
  lines.push(`      event: ${jsStr(t.source.event)},`);
  lines.push(`      date: ${jsStr(t.source.date)},`);
  lines.push(`      ply: ${t.source.ply},`);
  lines.push(`    },`);
  lines.push(`    evalMeta: { engine: ${jsStr(t.evalMeta.engine)}, depth: ${t.evalMeta.depth} },`);
  if (t.evalPawns !== undefined) lines.push(`    evalPawns: ${t.evalPawns},`);
  lines.push(`  },`);
  return lines.join('\n');
}

function renderPoolFile({ forced, safeUnsafe, cancel }) {
  return `import type { PremoveTask } from './premove-positions';

/**
 * Пул заданий Premove — сгенерирован tools/build-premove-pool.mjs из
 * tools/premove-candidates.json (реальные партии, см. поле source каждой
 * задачи) и офлайн-анализа Stockfish (см. evalMeta). НЕ РЕДАКТИРОВАТЬ
 * руками — перегенерировать скриптом.
 *
 * Каждая задача уже прошла src/data/premove-validator.ts-совместимые
 * проверки (легальность, уникальность, пороги 0.4/1.5 пешки, натуральность
 * альтернатив) на момент генерации — см. отчёт сборки в консоли скрипта.
 */
export const PREMOVE_FORCED_CAPTURE_POOL: PremoveTask[] = [
${forced.map(renderTask).join('\n')}
];

export const PREMOVE_SAFE_UNSAFE_POOL: PremoveTask[] = [
${safeUnsafe.map(renderTask).join('\n')}
];

export const PREMOVE_CANCEL_POOL: PremoveTask[] = [
${cancel.map(renderTask).join('\n')}
];
`;
}

main().catch((e) => {
  console.error(e);
  engine.stop();
  process.exit(1);
});
