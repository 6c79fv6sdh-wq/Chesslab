import { describe, it, expect } from 'vitest';
import {
  chooseBlindMove,
  pickSafeIdea,
  BEGINNER_PROFILE,
  type BlindProfile,
  type AnalysisLine,
} from '../src/core/blind-bot';
import { INITIAL_FEN, allLegalMoves, posFromFen, uciOf } from '../src/core/chess';

/**
 * Логика «слепого» бота проверяется без реального движка: `analyse`
 * подставная, отвечает заранее подготовленными строками — движок здесь
 * нужен только для оценки СЕРЬЁЗНОСТИ найденной угрозы материалу, всё
 * остальное (мат в один ход — свой и чужой, ранжирование идей) считается
 * настоящей логикой chessops на настоящих позициях, не мокается.
 */

const rndAlways = (v: number) => () => v;

/** Найти конкретный легальный ход по UCI — для явно собранных списков кандидатов. */
function moveByUci(fen: string, uci: string) {
  const pos = posFromFen(fen);
  const move = allLegalMoves(pos).find((m) => uciOf(m) === uci);
  if (!move) throw new Error(`нет такого легального хода: ${uci} в ${fen}`);
  return move;
}

const START = INITIAL_FEN;
// После 1.f3 e5, ход белых — g4 ведёт к Qh4# (Fool's Mate).
const FOOLS_MATE_SETUP = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2';
// После 1.f3 e5 2.g4, ход чёрных — Qh4# доступен прямо сейчас.
const FOOLS_MATE_READY = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';

const SAFE_REPLY: AnalysisLine = { move: 'e7e5', score: 20 };
const noThreat = async () => [SAFE_REPLY];

describe('chooseBlindMove: мат в один ход', () => {
  it('находит свой мат и, если «заметил» (rnd ниже шанса), играет его', async () => {
    const mv = await chooseBlindMove(noThreat, posFromFen(FOOLS_MATE_READY), BEGINNER_PROFILE, rndAlways(0));
    expect(uciOf(mv!)).toBe('d8h4');
  });

  it('не видит мат, если rnd выше шанса — играет другую идею', async () => {
    const mv = await chooseBlindMove(
      noThreat,
      posFromFen(FOOLS_MATE_READY),
      BEGINNER_PROFILE,
      rndAlways(0.99),
    );
    expect(uciOf(mv!)).not.toBe('d8h4');
  });
});

describe('pickSafeIdea: угроза соперника после кандидата', () => {
  it('замечает настоящий мат в один ход соперника и пробует следующего кандидата', async () => {
    const pos = posFromFen(FOOLS_MATE_SETUP);
    // g2g4 — реальный ход, ведущий к Qh4#; e2e4 — безопасная альтернатива.
    const candidates = [moveByUci(FOOLS_MATE_SETUP, 'g2g4'), moveByUci(FOOLS_MATE_SETUP, 'e2e4')];

    const mv = await pickSafeIdea(noThreat, pos, candidates, BEGINNER_PROFILE, rndAlways(0));
    expect(uciOf(mv!)).toBe('e2e4');
  });

  it('не замечает мат соперника (rnd выше шанса) — играет первого кандидата как задумал', async () => {
    const pos = posFromFen(FOOLS_MATE_SETUP);
    const candidates = [moveByUci(FOOLS_MATE_SETUP, 'g2g4'), moveByUci(FOOLS_MATE_SETUP, 'e2e4')];

    const mv = await pickSafeIdea(noThreat, pos, candidates, BEGINNER_PROFILE, rndAlways(0.99));
    expect(uciOf(mv!)).toBe('g2g4');
  });

  it('крупная потеря материала (выше порога), замечена — пробует следующего кандидата', async () => {
    const pos = posFromFen(START);
    const candidates = [moveByUci(START, 'e2e4'), moveByUci(START, 'd2d4')];
    const profile: BlindProfile = { ...BEGINNER_PROFILE, threatThreshold: 250 };
    let calls = 0;
    const analyse = async (): Promise<AnalysisLine[]> => {
      calls++;
      return calls === 1 ? [{ move: 'e7e5', score: 500 }] : [SAFE_REPLY];
    };

    const mv = await pickSafeIdea(analyse, pos, candidates, profile, rndAlways(0));
    expect(uciOf(mv!)).toBe('d2d4');
  });

  it('крупная потеря материала, но НЕ замечена (rnd выше шанса) — подставляется', async () => {
    const pos = posFromFen(START);
    const candidates = [moveByUci(START, 'e2e4'), moveByUci(START, 'd2d4')];
    const profile: BlindProfile = { ...BEGINNER_PROFILE, threatThreshold: 250 };
    const analyse = async (): Promise<AnalysisLine[]> => [{ move: 'e7e5', score: 500 }];

    const mv = await pickSafeIdea(analyse, pos, candidates, profile, rndAlways(0.99));
    expect(uciOf(mv!)).toBe('e2e4');
  });

  it('мелкая потеря (ниже порога) не замечается вовсе — играет первого кандидата', async () => {
    const pos = posFromFen(START);
    const candidates = [moveByUci(START, 'e2e4'), moveByUci(START, 'd2d4')];
    const profile: BlindProfile = { ...BEGINNER_PROFILE, threatThreshold: 250 };
    const analyse = async (): Promise<AnalysisLine[]> => [{ move: 'e7e5', score: 120 }];

    // rnd() = 0 не важен: ниже порога проверка вообще не срабатывает.
    const mv = await pickSafeIdea(analyse, pos, candidates, profile, rndAlways(0));
    expect(uciOf(mv!)).toBe('e2e4');
  });

  it('одна проверка на кандидата: не ищет вторую угрозу в той же позиции', async () => {
    const pos = posFromFen(START);
    const candidates = [moveByUci(START, 'e2e4')];
    let calls = 0;
    const analyse = async (): Promise<AnalysisLine[]> => {
      calls++;
      return [SAFE_REPLY];
    };

    await pickSafeIdea(analyse, pos, candidates, BEGINNER_PROFILE, rndAlways(0));
    expect(calls).toBe(1);
  });

  it('пустой список кандидатов — null, не исключение', async () => {
    const mv = await pickSafeIdea(noThreat, posFromFen(START), [], BEGINNER_PROFILE, rndAlways(0));
    expect(mv).toBeNull();
  });

  it('все кандидаты отбракованы проверкой — берёт первого как есть', async () => {
    const pos = posFromFen(START);
    const candidates = [moveByUci(START, 'e2e4'), moveByUci(START, 'd2d4')];
    const profile: BlindProfile = { ...BEGINNER_PROFILE, threatThreshold: 250 };
    const analyse = async (): Promise<AnalysisLine[]> => [{ move: 'e7e5', score: 900 }];

    const mv = await pickSafeIdea(analyse, pos, candidates, profile, rndAlways(0));
    expect(uciOf(mv!)).toBe('e2e4');
  });
});

describe('chooseBlindMove: край', () => {
  it('пустой список ходов (мат/пат уже стоит) — null, не исключение', async () => {
    // Позиция с чёрными в мате — legal-конструкция FEN, ходов нет вовсе.
    const mateFen = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    const mv = await chooseBlindMove(noThreat, posFromFen(mateFen), BEGINNER_PROFILE, rndAlways(0));
    expect(mv).toBeNull();
  });

  it('на первом ходу бот вообще что-то играет и это легальный ход', async () => {
    const pos = posFromFen(START);
    const legal = new Set(allLegalMoves(pos).map((m) => uciOf(m)));
    const mv = await chooseBlindMove(noThreat, pos, BEGINNER_PROFILE, rndAlways(0.99));
    expect(legal.has(uciOf(mv!))).toBe(true);
  });
});
