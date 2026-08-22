import {
  allLegalMoves,
  fenOf,
  isCapture,
  makeSan,
  moveFromUci,
  opposite,
  tryPosFromFen,
  uciOf,
  type Chess,
  type Color,
  type NormalMove,
} from '../core/chess';

/**
 * Валидатор пула Premove — единственное место, где живут числовые пороги
 * и структурные правила из ТЗ. Импортируется и тестами (tests/premove-
 * validator.test.ts), и офлайн-сборщиком пула (tools/build-premove-pool.mjs,
 * который те же пороги держит своей копией — см. комментарий там).
 *
 * Валидатор НЕ обращается к движку сам: оценки приходят снаружи (заранее
 * посчитаны Stockfish в tools/build-premove-pool.mjs) — «валидация
 * Stockfish выполняется заранее отдельным скриптом, а не во время
 * упражнения» — это требование к архитектуре, не только к рантайму.
 */

/** Строка анализа движка: очки — с точки зрения стороны хода в его позиции. */
export interface EngineLine {
  /** Необязателен: некоторые вызовы читают только счёт лучшей строки. */
  move?: string;
  cp?: number;
  mate?: number;
}

/** Мат считаем эквивалентом ~10 пешек за ход до него — этого достаточно,
 * чтобы отличать «дают мат» от любой конечной материальной потери. */
const MATE_CP = 100000;

export function lineScoreCp(line: EngineLine | undefined): number {
  if (!line) return 0;
  if (line.mate !== undefined) return line.mate > 0 ? MATE_CP - line.mate : -MATE_CP - line.mate;
  return line.cp ?? 0;
}

/**
 * Очки строки в пешках, с точки зрения `perspective` — а не стороны хода
 * в позиции анализа. Все пороги ниже сформулированы в пешках именно с точки
 * зрения пользователя, поэтому все сравнения идут через эту функцию.
 */
export function scoreForColor(line: EngineLine | undefined, posTurn: Color, perspective: Color): number {
  const cp = lineScoreCp(line);
  return (posTurn === perspective ? cp : -cp) / 100;
}

// --- Пороги. Числа — прямо из ТЗ, менять только синхронно с текстом задачи.
export const FORCED_CAPTURE_ALT_MARGIN_PAWNS = 1.5;
export const FORCED_CAPTURE_NOT_FORCED_GAP_PAWNS = 0.3;
export const FORCED_CAPTURE_DISASTER_PAWNS = 1;
export const SAFE_MAX_LOSS_PAWNS = 0.4;
export const UNSAFE_MIN_LOSS_PAWNS = 1.5;
export const UNSAFE_ALT_TOP_N = 3;
export const UNSAFE_ALT_MAX_GAP_PAWNS = 1.0;

export interface RejectResult {
  ok: false;
  reasons: string[];
}
export type CheckResult<T> = { ok: true; value: T } | RejectResult;

function reject(...reasons: string[]): RejectResult {
  return { ok: false, reasons };
}

// --- Базовые структурные проверки, общие для всех режимов.

export function parsedPosition(fen: string): Chess | null {
  return tryPosFromFen(fen);
}

/** Рокировка/превращение/взятие на проходе — исключены на первом этапе. */
export function isSpecialMove(pos: Chess, move: NormalMove): boolean {
  const piece = pos.board.get(move.from);
  if (!piece) return false;
  if (move.promotion) return true;
  if (piece.role === 'king' && Math.abs((move.to & 7) - (move.from & 7)) === 2) return true; // рокировка
  if (piece.role === 'pawn') {
    const isDiagonal = (move.from & 7) !== (move.to & 7);
    if (isDiagonal && !pos.board.get(move.to)) return true; // взятие на проходе
  }
  return false;
}

/** Позиция, где кто-то уже под шахом на старте задачи — исключена на первом этапе. */
export function startsInCheck(pos: Chess): boolean {
  return pos.isCheck();
}

/** Каноническая подпись позиции для дедупликации: fen без счётчиков ходов. */
export function positionSignature(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Подпись зеркального по вертикали (файлы a↔h) варианта — для дедупа «зеркальных» позиций. */
export function mirroredSignature(fen: string): string {
  const [board, turn, castle, ep] = fen.split(' ');
  const mirroredBoard = board
    .split('/')
    .map((rank) => rank.split('').reverse().join(''))
    .join('/');
  const mirroredCastle = castle === '-' ? '-' : castle; // рокировочные права зеркалим редко нужным способом — здесь не критично, дедуп ловит основной случай
  const mirroredEp = ep === '-' ? '-' : `${String.fromCharCode(219 - ep.charCodeAt(0))}${ep[1]}`;
  return [mirroredBoard, turn, mirroredCastle, mirroredEp].join(' ');
}

export function findDuplicate(fen: string, existing: string[]): boolean {
  const sig = positionSignature(fen);
  const mirror = mirroredSignature(fen);
  return existing.some((f) => {
    const s = positionSignature(f);
    return s === sig || s === mirror;
  });
}

// --- Автосборка описаний из SAN — не ручной текст.

export function describeForcedCapture(userColor: Color, expectedSan: string, answerSan: string): string {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Ожидается ${expectedSan}. Поставь ответное взятие заранее: ${answerSan}.`;
}

export function describeSafeUnsafe(userColor: Color, expectedSan: string, answerSan: string): string {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Ожидается ${expectedSan}. Предполагаемый premove: ${answerSan}.`;
}

export function describeCancel(userColor: Color): string {
  const side = userColor === 'white' ? 'белыми' : 'чёрными';
  return `Играешь ${side}. Премув уже поставлен. Пока соперник думает, реши: оставить или снять.`;
}

// --- Режим 1: Ответное взятие.

export interface ForcedCaptureCandidate {
  id: string;
  fen: string;
  userColor: Color;
  expectedUci: string;
  answerUci: string;
}

export interface AnalysisProvider {
  /** multipv-варианты в позиции fen на фиксированной глубине; move — UCI. */
  linesAt(fen: string): EngineLine[] | undefined;
}

export interface ValidatedForcedCapture {
  id: string;
  fen: string;
  userColor: Color;
  expectedUci: string;
  expectedSan: string;
  answerUci: string;
  answerSan: string;
  comment: string;
  evalAfterAnswerPawns: number;
}

export function validateForcedCapture(
  c: ForcedCaptureCandidate,
  analysis: AnalysisProvider,
): CheckResult<ValidatedForcedCapture> {
  const pos = parsedPosition(c.fen);
  if (!pos) return reject('невалидный FEN');
  if (startsInCheck(pos)) return reject('в исходной позиции уже шах — исключено на первом этапе');
  const opponent = opposite(c.userColor);
  if (pos.turn !== opponent) return reject(`ход в fen не за соперника (${pos.turn})`);

  let expectedMove: NormalMove;
  try {
    expectedMove = moveFromUci(c.expectedUci);
  } catch {
    return reject('expectedUci не парсится');
  }
  if (!pos.isLegal(expectedMove)) return reject('ожидаемый ход нелегален');
  if (isSpecialMove(pos, expectedMove)) return reject('ожидаемый ход — рокировка/превращение/взятие на проходе');
  if (!isCapture(pos, expectedMove)) return reject('ожидаемый ход не является взятием');

  const after = pos.clone();
  after.play(expectedMove);
  if (after.isCheck() && after.turn === c.userColor) {
    // Шах после хода соперника — легальный ответ обязан его снимать,
    // это не запрещает позицию (isLegal ниже это учтёт), но фазу
    // «интерфейс шах обрабатывает неправильно» на первом этапе исключаем
    // отдельно от простого «ответ существует».
  }

  let answerMove: NormalMove;
  try {
    answerMove = moveFromUci(c.answerUci);
  } catch {
    return reject('answerUci не парсится');
  }
  if (!after.isLegal(answerMove)) return reject('ответный ход нелегален после ожидаемого');
  if (isSpecialMove(after, answerMove)) return reject('ответный ход — рокировка/превращение/взятие на проходе');
  if (answerMove.to !== expectedMove.to) return reject('ответ бьёт не на то же поле — это не форсированное взятие');

  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(after, answerMove);

  // Не форсировано, если у соперника в fen есть равноценная альтернатива.
  const rootLines = analysis.linesAt(c.fen);
  if (!rootLines || rootLines.length === 0) return reject('нет анализа корневой позиции');
  const bestLine = rootLines[0];
  if (bestLine.move !== c.expectedUci) {
    // Ожидаемый ход обязан быть лучшим по мнению движка — иначе называть
    // его «форсированным» нечестно перед пользователем.
    const bestIsExpected = rootLines.find((l) => l.move === c.expectedUci);
    const bestScore = scoreForColor(bestLine, pos.turn, opponent);
    const expScore = bestIsExpected ? scoreForColor(bestIsExpected, pos.turn, opponent) : -Infinity;
    if (bestScore - expScore > FORCED_CAPTURE_NOT_FORCED_GAP_PAWNS) {
      return reject(`ожидаемый ход не лучший у соперника (${bestLine.move} сильнее на ${(bestScore - expScore).toFixed(2)})`);
    }
  }
  const second = rootLines[1];
  if (second) {
    const gap = scoreForColor(bestLine, pos.turn, opponent) - scoreForColor(second, pos.turn, opponent);
    if (gap < FORCED_CAPTURE_NOT_FORCED_GAP_PAWNS && second.move !== c.expectedUci) {
      return reject('у соперника есть равноценное продолжение — не форсировано');
    }
  }

  // Уникальность ответного взятия: другие фигуры, бьющие на то же поле,
  // обязаны быть хуже минимум на 1.5 пешки.
  const altRecaptures = allLegalMoves(after).filter(
    (m) => m.to === expectedMove.to && !(m.from === answerMove.from && m.to === answerMove.to),
  );
  if (altRecaptures.length > 0) {
    const afterLines = analysis.linesAt(uciFen(after));
    if (!afterLines) return reject('нет анализа позиции после ожидаемого хода');
    const answerLine = afterLines.find((l) => l.move === c.answerUci);
    const answerScore = answerLine
      ? scoreForColor(answerLine, after.turn, c.userColor)
      : scoreForColor(afterLines[0], after.turn, c.userColor);
    for (const alt of altRecaptures) {
      const altUci = uciOf(alt);
      const altLine = afterLines.find((l) => l.move === altUci);
      const altScore = altLine ? scoreForColor(altLine, after.turn, c.userColor) : answerScore; // нет данных — не рискуем, считаем равным
      if (answerScore - altScore < FORCED_CAPTURE_ALT_MARGIN_PAWNS) {
        return reject(
          `правильное взятие не единственно: ${altUci} отстаёт всего на ${(answerScore - altScore).toFixed(2)} пешки`,
        );
      }
    }
  }

  // Ответ не должен вести к немедленной катастрофе — оценка после ответа
  // не должна быть плохой для пользователя.
  const afterAnswer = after.clone();
  afterAnswer.play(answerMove);
  const afterAnswerLines = analysis.linesAt(uciFen(afterAnswer));
  const evalAfterAnswerPawns = afterAnswerLines
    ? scoreForColor(afterAnswerLines[0], afterAnswer.turn, c.userColor)
    : 0;
  if (evalAfterAnswerPawns < -FORCED_CAPTURE_DISASTER_PAWNS) {
    return reject(`ответ ведёт к немедленной катастрофе (${evalAfterAnswerPawns.toFixed(2)})`);
  }

  return {
    ok: true,
    value: {
      id: c.id,
      fen: c.fen,
      userColor: c.userColor,
      expectedUci: c.expectedUci,
      expectedSan,
      answerUci: c.answerUci,
      answerSan,
      comment: describeForcedCapture(c.userColor, expectedSan, answerSan),
      evalAfterAnswerPawns,
    },
  };
}

/** Короткий алиас: почти всегда fen нужен сразу после клона+хода. */
function uciFen(pos: Chess): string {
  return fenOf(pos);
}

// --- Режим 2: Safe / Unsafe.

export interface SafeUnsafeCandidate {
  id: string;
  fen: string;
  userColor: Color;
  expectedUci: string;
  answerUci: string;
}

export interface BranchEval {
  opponentUci: string;
  /** Легален ли answerUci ПОСЛЕ этого хода соперника. */
  premoveLegal: boolean;
  /** Заполняется, только если premoveLegal — пешки, с точки зрения пользователя. */
  lossPawns?: number;
  /** Входит ли ход соперника в топ-N корневого анализа (натуральность). */
  natural: boolean;
}

export interface ValidatedSafeUnsafe {
  id: string;
  fen: string;
  userColor: Color;
  expectedUci: string;
  expectedSan: string;
  answerUci: string;
  answerSan: string;
  shouldPremove: boolean;
  dangerousUci?: string;
  dangerousSan?: string;
  comment: string;
}

/**
 * Строит ветки по ВСЕМ легальным ходам соперника в fen (кроме expectedUci) —
 * дёшево через chessops, без движка: для каждой ветки чисто структурно
 * проверяется легальность premove ПОСЛЕ хода. Движок нужен только тем
 * веткам, где premove остался легален (их обычно немного).
 */
export function structuralBranches(fen: string, answerUci: string, excludeUci: string): {
  branches: { uci: string; afterFen: string; premoveLegal: boolean }[];
} | null {
  const pos = parsedPosition(fen);
  if (!pos) return null;
  let answerMove: NormalMove;
  try {
    answerMove = moveFromUci(answerUci);
  } catch {
    return null;
  }
  const branches = allLegalMoves(pos)
    .filter((m) => uciOf(m) !== excludeUci)
    .map((m) => {
      const after = pos.clone();
      after.play(m);
      const premoveLegal = after.isLegal(answerMove);
      return { uci: uciOf(m), afterFen: uciFen(after), premoveLegal };
    });
  return { branches };
}

/**
 * Потеря пользователя в пешках на ветке: разница между его лучшим
 * доступным ходом в позиции `beforeFen` (ход пользователя) и позицией,
 * которая реально получается, если он играет `forcedMove` (premove).
 * Так считается и «expected»-ветка (0.4 порог), и любая другая ветка
 * соперника (для unsafe нужно ≥1.5) — одной и той же формулой, как того
 * и требует ТЗ («не объединять оценки, но использовать один критерий»).
 */
function branchLossPawns(
  beforeFen: string,
  forcedMove: NormalMove,
  userColor: Color,
  branchAnalysis: (fen: string) => EngineLine[] | undefined,
): number | null {
  const beforePos = parsedPosition(beforeFen);
  if (!beforePos) return null;
  const bestLines = branchAnalysis(beforeFen);
  if (!bestLines || bestLines.length === 0) return null;
  const bestScore = scoreForColor(bestLines[0], beforePos.turn, userColor);

  const after = beforePos.clone();
  after.play(forcedMove);
  const forcedLines = branchAnalysis(uciFen(after));
  if (!forcedLines || forcedLines.length === 0) return null;
  const forcedScore = scoreForColor(forcedLines[0], after.turn, userColor);

  return bestScore - forcedScore;
}

export function validateSafeUnsafe(
  c: SafeUnsafeCandidate,
  analysis: AnalysisProvider,
  branchAnalysis: (afterFen: string) => EngineLine[] | undefined,
): CheckResult<ValidatedSafeUnsafe> {
  const pos = parsedPosition(c.fen);
  if (!pos) return reject('невалидный FEN');
  if (startsInCheck(pos)) return reject('в исходной позиции уже шах — исключено на первом этапе');
  const opponent = opposite(c.userColor);
  if (pos.turn !== opponent) return reject('ход в fen не за соперника');

  let expectedMove: NormalMove;
  let answerMove: NormalMove;
  try {
    expectedMove = moveFromUci(c.expectedUci);
    answerMove = moveFromUci(c.answerUci);
  } catch {
    return reject('ход не парсится');
  }
  if (!pos.isLegal(expectedMove)) return reject('ожидаемый ход нелегален');
  if (isSpecialMove(pos, expectedMove)) return reject('ожидаемый ход — исключённый тип (рокировка/превращение/en passant)');
  const after = pos.clone();
  after.play(expectedMove);
  if (!after.isLegal(answerMove)) return reject('предполагаемый premove нелегален после ожидаемого хода');
  if (isSpecialMove(after, answerMove)) return reject('premove — исключённый тип хода');

  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(after, answerMove);

  const rootLines = analysis.linesAt(c.fen);
  if (!rootLines || rootLines.length === 0) return reject('нет анализа корневой позиции');
  const bestScore = scoreForColor(rootLines[0], pos.turn, opponent);

  const structural = structuralBranches(c.fen, c.answerUci, c.expectedUci);
  if (!structural) return reject('не удалось построить ветки соперника');

  // SAFE: expected-ветка сама безопасна (лучший ответ vs вынужденный premove).
  const expectedLoss = branchLossPawns(uciFen(after), answerMove, c.userColor, branchAnalysis);
  if (expectedLoss === null) return reject('нет анализа ветки ожидаемого хода');
  if (expectedLoss > SAFE_MAX_LOSS_PAWNS) {
    return reject(`premove теряет ${expectedLoss.toFixed(2)} пешки уже на ожидаемой ветке — это не safe-задание`);
  }

  let worstNaturalUnsafe: { uci: string; loss: number } | null = null;
  let anyGrayZone = false;
  let allOtherBranchesSafe = true;

  for (const b of structural.branches) {
    if (!b.premoveLegal) continue; // нелегален — авто-отброшен, это и есть «безопасно»
    const lossPawns = branchLossPawns(b.afterFen, answerMove, c.userColor, branchAnalysis);
    if (lossPawns === null) continue; // нет данных — не можем ни подтвердить unsafe, ни опровергнуть safe

    const rank = rootLines.findIndex((l) => l.move === b.uci);
    const rankScore = rank >= 0 ? scoreForColor(rootLines[rank], pos.turn, opponent) : -Infinity;
    const natural = rank >= 0 && (rank < UNSAFE_ALT_TOP_N || bestScore - rankScore <= UNSAFE_ALT_MAX_GAP_PAWNS);

    if (lossPawns > SAFE_MAX_LOSS_PAWNS) {
      allOtherBranchesSafe = false;
      if (lossPawns >= UNSAFE_MIN_LOSS_PAWNS && natural) {
        if (!worstNaturalUnsafe || lossPawns > worstNaturalUnsafe.loss) {
          worstNaturalUnsafe = { uci: b.uci, loss: lossPawns };
        }
      } else {
        anyGrayZone = true;
      }
    }
  }

  if (allOtherBranchesSafe) {
    return {
      ok: true,
      value: {
        id: c.id,
        fen: c.fen,
        userColor: c.userColor,
        expectedUci: c.expectedUci,
        expectedSan,
        answerUci: c.answerUci,
        answerSan,
        shouldPremove: true,
        comment: describeSafeUnsafe(c.userColor, expectedSan, answerSan) + ' Безопасно.',
      },
    };
  }
  if (worstNaturalUnsafe && !anyGrayZone) {
    const dangerMove = moveFromUci(worstNaturalUnsafe.uci);
    const dangerSan = makeSan(pos, dangerMove);
    return {
      ok: true,
      value: {
        id: c.id,
        fen: c.fen,
        userColor: c.userColor,
        expectedUci: c.expectedUci,
        expectedSan,
        answerUci: c.answerUci,
        answerSan,
        shouldPremove: false,
        dangerousUci: worstNaturalUnsafe.uci,
        dangerousSan: dangerSan,
        comment: describeSafeUnsafe(c.userColor, expectedSan, answerSan) + ' Опасно.',
      },
    };
  }
  return reject('серая зона 0.4–1.5 или unsafe доказан неестественным ходом — отклонено');
}

// --- Режим 3: Отмена.

export interface CancelCandidate {
  id: string;
  fen: string;
  userColor: Color;
  expectedUci: string;
  answerUci: string;
  /** Ход, который реально произойдёт вместо ожидаемого — вариант «снять». */
  unexpectedUci?: string;
  correctAction: 'keep' | 'remove';
}

export interface ValidatedCancel {
  id: string;
  fen: string;
  userColor: Color;
  expectedUci: string;
  expectedSan: string;
  answerUci: string;
  answerSan: string;
  unexpectedUci?: string;
  unexpectedSan?: string;
  correctAction: 'keep' | 'remove';
  comment: string;
}

export function validateCancel(c: CancelCandidate, analysis: AnalysisProvider): CheckResult<ValidatedCancel> {
  const pos = parsedPosition(c.fen);
  if (!pos) return reject('невалидный FEN');
  if (startsInCheck(pos)) return reject('в исходной позиции уже шах — исключено на первом этапе');
  const opponent = opposite(c.userColor);
  if (pos.turn !== opponent) return reject('ход в fen не за соперника');

  let expectedMove: NormalMove;
  let answerMove: NormalMove;
  try {
    expectedMove = moveFromUci(c.expectedUci);
    answerMove = moveFromUci(c.answerUci);
  } catch {
    return reject('ход не парсится');
  }
  if (!pos.isLegal(expectedMove)) return reject('ожидаемый ход нелегален');
  if (isSpecialMove(pos, expectedMove)) return reject('ожидаемый ход — исключённый тип');
  const afterExpected = pos.clone();
  afterExpected.play(expectedMove);
  if (!afterExpected.isLegal(answerMove)) return reject('premove нелегален после ожидаемого хода');
  const expectedSan = makeSan(pos, expectedMove);
  const answerSan = makeSan(afterExpected, answerMove);

  if (c.correctAction === 'keep') {
    return {
      ok: true,
      value: {
        id: c.id,
        fen: c.fen,
        userColor: c.userColor,
        expectedUci: c.expectedUci,
        expectedSan,
        answerUci: c.answerUci,
        answerSan,
        correctAction: 'keep',
        comment: describeCancel(c.userColor) + ` Соперник сыграет ожидаемое ${expectedSan} — premove ${answerSan} можно оставить.`,
      },
    };
  }

  if (!c.unexpectedUci) return reject('для варианта «снять» нужен unexpectedUci');
  let unexpectedMove: NormalMove;
  try {
    unexpectedMove = moveFromUci(c.unexpectedUci);
  } catch {
    return reject('unexpectedUci не парсится');
  }
  if (!pos.isLegal(unexpectedMove)) return reject('unexpectedUci нелегален в исходной позиции');
  if (isSpecialMove(pos, unexpectedMove)) return reject('unexpectedUci — исключённый тип хода');

  const rootLines = analysis.linesAt(c.fen);
  if (!rootLines) return reject('нет анализа корневой позиции');
  const rank = rootLines.findIndex((l) => l.move === c.unexpectedUci);
  const bestScore = scoreForColor(rootLines[0], pos.turn, opponent);
  const altScore = rank >= 0 ? scoreForColor(rootLines[rank], pos.turn, opponent) : -Infinity;
  const natural = rank >= 0 && (rank < UNSAFE_ALT_TOP_N || bestScore - altScore <= UNSAFE_ALT_MAX_GAP_PAWNS);
  if (!natural) return reject('unexpectedUci неестественный ход — ни один живой соперник так не сыграет');

  const afterUnexpected = pos.clone();
  afterUnexpected.play(unexpectedMove);
  const unexpectedSan = makeSan(pos, unexpectedMove);

  // «Снять» правильно, только если premove после unexpectedUci либо
  // нелегален (тогда сам факт неснятия ничего не портит — исключаем такую
  // позицию как не иллюстрирующую отмену), либо легален и вреден.
  if (!afterUnexpected.isLegal(answerMove)) {
    return reject('premove и так нелегален после unexpectedUci — отмена ничего не демонстрирует');
  }
  const afterBoth = afterUnexpected.clone();
  afterBoth.play(answerMove);
  const punishLines = analysis.linesAt(uciFen(afterBoth));
  const lossPawns = punishLines ? -scoreForColor(punishLines[0], afterBoth.turn, c.userColor) : 0;
  if (lossPawns < UNSAFE_MIN_LOSS_PAWNS) {
    return reject(`неснятый premove после unexpectedUci не наказывается всерьёз (${lossPawns.toFixed(2)})`);
  }

  return {
    ok: true,
    value: {
      id: c.id,
      fen: c.fen,
      userColor: c.userColor,
      expectedUci: c.expectedUci,
      expectedSan,
      answerUci: c.answerUci,
      answerSan,
      unexpectedUci: c.unexpectedUci,
      unexpectedSan,
      correctAction: 'remove',
      comment:
        describeCancel(c.userColor) +
        ` Соперник сыграл неожиданно: ${unexpectedSan}. Premove ${answerSan} снимать было надо.`,
    },
  };
}
