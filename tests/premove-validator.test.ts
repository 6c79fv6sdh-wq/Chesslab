import { describe, it, expect } from 'vitest';
import {
  describeCancel,
  describeForcedCapture,
  describeSafeUnsafe,
  findDuplicate,
  isSpecialMove,
  mirroredSignature,
  positionSignature,
  startsInCheck,
  validateCancel,
  validateForcedCapture,
  validateSafeUnsafe,
  type AnalysisProvider,
  type EngineLine,
} from '../src/data/premove-validator';
import { fenOf, moveFromUci, posFromFen } from '../src/core/chess';

/** Фиктивный анализ: fen → заранее заданные строки. Не трогает движок —
 * тесты валидатора обязаны быть быстрыми и детерминированными. */
function fakeAnalysis(table: Record<string, EngineLine[]>): AnalysisProvider {
  return {
    linesAt: (fen) => table[fen],
  };
}
function fakeBranch(table: Record<string, EngineLine[]>, fallback?: EngineLine[]) {
  return (fen: string) => table[fen] ?? fallback;
}

// Fischer – Spassky, партия 9, 1992: 3...a6 4.Bxc6, только пешка d7 бьёт
// «правильно» (пешка b7 тоже технически может, но это заведомо хуже).
const FEN_BXC6 = 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
const FEN_BXC6_AFTER = 'r1bqkbnr/1ppp1ppp/p1B5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';

describe('premove-validator: базовые структурные проверки', () => {
  it('FEN легален / нелегален', () => {
    expect(startsInCheck(posFromFen(FEN_BXC6))).toBe(false);
    expect(() => posFromFen('not a fen')).toThrow();
  });

  it('рокировка/превращение/взятие на проходе распознаются как исключённый тип хода', () => {
    const castlePos = posFromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(isSpecialMove(castlePos, moveFromUci('e1g1'))).toBe(true);

    const promoPos = posFromFen('8/P7/8/8/8/8/8/k1K5 w - - 0 1');
    expect(isSpecialMove(promoPos, { ...moveFromUci('a7a8'), promotion: 'queen' })).toBe(true);

    const epPos = posFromFen('8/8/8/pP6/8/8/8/k1K5 w - a6 0 1');
    expect(isSpecialMove(epPos, moveFromUci('b5a6'))).toBe(true);

    const normalCapture = posFromFen(FEN_BXC6);
    expect(isSpecialMove(normalCapture, moveFromUci('b5c6'))).toBe(false);
  });

  it('дедуп: одинаковая позиция и её зеркало по вертикали — дубликаты', () => {
    const existing = [FEN_BXC6];
    expect(findDuplicate(FEN_BXC6, existing)).toBe(true);
    // Зеркалим доску по файлам (a↔h) — та же структура, другая сторона.
    const mirrored = mirroredSignature(FEN_BXC6);
    expect(findDuplicate(`${mirrored.split(' ')[0]} w KQkq - 0 4`, existing)).toBe(true);
    expect(findDuplicate('8/8/8/8/8/8/8/4K2k w - - 0 1', existing)).toBe(false);
  });

  it('подпись позиции игнорирует счётчики полуходов, но не саму доску', () => {
    expect(positionSignature(FEN_BXC6)).toBe(positionSignature(FEN_BXC6.replace('0 4', '5 9')));
    expect(positionSignature(FEN_BXC6)).not.toBe(positionSignature(FEN_BXC6_AFTER));
  });

  it('описания собираются из SAN, а не пишутся вручную', () => {
    expect(describeForcedCapture('black', 'Bxc6', 'dxc6')).toContain('Bxc6');
    expect(describeForcedCapture('black', 'Bxc6', 'dxc6')).toContain('dxc6');
    expect(describeSafeUnsafe('white', 'Qxd4', 'Rxd4')).toContain('Qxd4');
    expect(describeSafeUnsafe('white', 'Qxd4', 'Rxd4')).toContain('Rxd4');
    expect(describeCancel('white')).toContain('белыми');
    expect(describeCancel('black')).toContain('чёрными');
  });
});

describe('premove-validator: режим «Ответное взятие»', () => {
  const base = {
    id: 't1',
    fen: FEN_BXC6,
    userColor: 'black' as const,
    expectedUci: 'b5c6',
    answerUci: 'd7c6',
  };

  it('очередь premove проверяется В ПОЗИЦИИ ПОСЛЕ ожидаемого хода соперника, не в текущей', () => {
    // dxc6 нелегален в исходном fen (там на c6 стоит конь, а не слон
    // соперника) — легален он становится только после Bxc6. Если бы
    // валидатор проверял answerUci прямо в fen, эта позиция бы не прошла.
    const posBefore = posFromFen(FEN_BXC6);
    expect(posBefore.isLegal(moveFromUci('d7c6'))).toBe(false);
    const analysis = fakeAnalysis({
      [FEN_BXC6]: [
        { move: 'b5c6', cp: 40 },
        { move: 'e4e5', cp: 5 },
      ],
      [FEN_BXC6_AFTER]: [
        { move: 'd7c6', cp: -10 },
        { move: 'b7c6', cp: -300 }, // альтернативная пешка — заметно хуже
      ],
    });
    const result = validateForcedCapture(base, analysis);
    expect(result.ok, !result.ok ? result.reasons.join('; ') : '').toBe(true);
  });

  it('ожидаемый ход обязан быть взятием', () => {
    const analysis = fakeAnalysis({
      [FEN_BXC6]: [{ move: 'e4e5', cp: 0 }],
    });
    const result = validateForcedCapture({ ...base, expectedUci: 'e4e5', answerUci: 'd7c6' }, analysis);
    expect(result.ok).toBe(false);
  });

  it('ответ, бьющий не на то же поле, — не форсированное взятие', () => {
    const analysis = fakeAnalysis({ [FEN_BXC6]: [{ move: 'b5c6', cp: 40 }] });
    const result = validateForcedCapture({ ...base, answerUci: 'e8e7' }, analysis);
    expect(result.ok).toBe(false);
  });

  it('правильный ответ обязан быть единственным: равноценная альтернатива отклоняет задачу', () => {
    const analysis = fakeAnalysis({
      [FEN_BXC6]: [{ move: 'b5c6', cp: 40 }],
      [FEN_BXC6_AFTER]: [
        { move: 'd7c6', cp: -10 },
        { move: 'b7c6', cp: -20 }, // отстаёт всего на 0.1 — серая зона, не 1.5
      ],
    });
    const result = validateForcedCapture(base, analysis);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/не единственно/);
  });

  it('ориентация: userColor и сторона, которой отвечает пользователь, совпадают', () => {
    const analysis = fakeAnalysis({
      [FEN_BXC6]: [
        { move: 'b5c6', cp: 40 },
        { move: 'e4e5', cp: 5 },
      ],
      [FEN_BXC6_AFTER]: [
        { move: 'd7c6', cp: -10 },
        { move: 'b7c6', cp: -300 },
      ],
    });
    const result = validateForcedCapture(base, analysis);
    expect(result.ok, !result.ok ? result.reasons.join('; ') : '').toBe(true);
    if (result.ok) expect(result.value.userColor).toBe('black');
  });

  it('описание в итоговой задаче совпадает с фактическими SAN хода и ответа', () => {
    const analysis = fakeAnalysis({
      [FEN_BXC6]: [
        { move: 'b5c6', cp: 40 },
        { move: 'e4e5', cp: 5 },
      ],
      [FEN_BXC6_AFTER]: [
        { move: 'd7c6', cp: -10 },
        { move: 'b7c6', cp: -300 },
      ],
    });
    const result = validateForcedCapture(base, analysis);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expectedSan).toBe('Bxc6');
      expect(result.value.answerSan).toBe('dxc6');
      expect(result.value.comment).toContain('Bxc6');
      expect(result.value.comment).toContain('dxc6');
    }
  });
});

describe('premove-validator: режим Safe/Unsafe', () => {
  // Учебная позиция: белый король g2, чёрный король g8, чёрная пешка a7.
  // У чёрных 6 легальных ходов (4 короля + a7a6/a7a5). Премув — Kh2,
  // безобидный шаффл королём, который остаётся легален при любом ответе
  // чёрных (ничто не мешает Kg2-h2 в любой из веток).
  const fen = '6k1/p7/8/8/8/8/6K1/8 b - - 0 1';
  const answerMove = moveFromUci('g2h2');

  it('safe: во всех ветках соперника premove либо нелегален (отброшен), либо теряет ≤0.4', () => {
    const analysis = fakeAnalysis({
      [fen]: [
        { move: 'g8h7', cp: 0 },
        { move: 'a7a5', cp: 0 },
      ],
    });
    // Все ветки одинаково тихие — король-шаффл ничего не портит нигде.
    const branch = fakeBranch({}, [{ cp: 0 }]);
    const result = validateSafeUnsafe(
      { id: 's1', fen, userColor: 'white', expectedUci: 'g8h7', answerUci: 'g2h2' },
      analysis,
      branch,
    );
    expect(result.ok, !result.ok ? result.reasons.join('; ') : '').toBe(true);
    if (result.ok) expect(result.value.shouldPremove).toBe(true);
  });

  it('серая зона 0.4–1.5 (не safe и не unsafe) отклоняет задачу целиком', () => {
    // На ветке a7a5 форсированный премув проигрывает 0.8 пешки — это выше
    // порога safe (0.4), но ниже порога unsafe (1.5): такую задачу нельзя
    // относить ни к одной из категорий.
    const start = posFromFen(fen);
    const altMove = moveFromUci('a7a5');
    const afterAlt = start.clone();
    afterAlt.play(altMove);
    const afterAltFen = fenOf(afterAlt);
    const afterAltAnswer = afterAlt.clone();
    afterAltAnswer.play(answerMove);
    const afterAltAnswerFen = fenOf(afterAltAnswer);

    const analysis = fakeAnalysis({
      [fen]: [
        { move: 'g8h7', cp: 0 },
        { move: 'a7a5', cp: -5 }, // естественная альтернатива, топ-2
      ],
    });
    const branch = fakeBranch(
      {
        [afterAltFen]: [{ move: 'g2h2', cp: 0 }], // лучший ход белых в этой ветке — 0
        [afterAltAnswerFen]: [{ move: 'g8g7', cp: 80 }], // а после форсированного premove чёрные лучше на 0.8
      },
      [{ cp: 0 }],
    );
    const result = validateSafeUnsafe(
      { id: 's2', fen, userColor: 'white', expectedUci: 'g8h7', answerUci: 'g2h2' },
      analysis,
      branch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/серая зона/);
  });

  it('unsafe: естественная альтернатива, после которой premove легален и теряет ≥1.5, помечает задачу опасной', () => {
    const start = posFromFen(fen);
    const altMove = moveFromUci('a7a5');
    const afterAlt = start.clone();
    afterAlt.play(altMove);
    const afterAltFen = fenOf(afterAlt);
    const afterAltAnswer = afterAlt.clone();
    afterAltAnswer.play(answerMove);
    const afterAltAnswerFen = fenOf(afterAltAnswer);

    const analysis = fakeAnalysis({
      [fen]: [
        { move: 'g8h7', cp: 0 },
        { move: 'a7a5', cp: -5 },
      ],
    });
    const branch = fakeBranch(
      {
        [afterAltFen]: [{ move: 'g2h2', cp: 0 }],
        [afterAltAnswerFen]: [{ move: 'g8g7', cp: 200 }], // теряем целых 2 пешки
      },
      [{ cp: 0 }],
    );
    const result = validateSafeUnsafe(
      { id: 's3', fen, userColor: 'white', expectedUci: 'g8h7', answerUci: 'g2h2' },
      analysis,
      branch,
    );
    expect(result.ok, !result.ok ? result.reasons.join('; ') : '').toBe(true);
    if (result.ok) {
      expect(result.value.shouldPremove).toBe(false);
      expect(result.value.dangerousUci).toBe('a7a5');
    }
  });
});

describe('premove-validator: режим «Отмена»', () => {
  const fen = FEN_BXC6;

  it('вариант «оставить» валиден без unexpectedUci', () => {
    const analysis = fakeAnalysis({ [fen]: [{ move: 'b5c6', cp: 40 }] });
    const result = validateCancel(
      { id: 'c1', fen, userColor: 'black', expectedUci: 'b5c6', answerUci: 'd7c6', correctAction: 'keep' },
      analysis,
    );
    expect(result.ok, !result.ok ? result.reasons.join('; ') : '').toBe(true);
  });

  it('вариант «снять» без unexpectedUci отклоняется', () => {
    const analysis = fakeAnalysis({ [fen]: [{ move: 'b5c6', cp: 40 }] });
    const result = validateCancel(
      { id: 'c2', fen, userColor: 'black', expectedUci: 'b5c6', answerUci: 'd7c6', correctAction: 'remove' },
      analysis,
    );
    expect(result.ok).toBe(false);
  });

  it('решение «снять» требует, чтобы premove после unexpectedUci оставался легален и реально наказывался', () => {
    const analysis = fakeAnalysis({
      [fen]: [
        { move: 'f3g5', cp: 30 }, // естественная альтернатива — топ-1
        { move: 'b5c6', cp: 20 },
      ],
    });
    // f3g5 не задевает d7/c6 — dxc6 там нелегален (нечего бить), значит
    // это не годится как «снять»-сценарий: должно быть отклонено.
    const result = validateCancel(
      {
        id: 'c3',
        fen,
        userColor: 'black',
        expectedUci: 'b5c6',
        answerUci: 'd7c6',
        unexpectedUci: 'f3g5',
        correctAction: 'remove',
      },
      analysis,
    );
    expect(result.ok).toBe(false);
  });
});
