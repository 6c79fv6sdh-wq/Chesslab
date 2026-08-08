import { describe, it, expect } from 'vitest';
import {
  BOT_CONFIGS,
  Clocks,
  botDelay,
  chooseMove,
  formatClock,
  scoreMove,
  type BotProfile,
} from '../src/modules/scramble-logic';
import { INITIAL_FEN, allLegalMoves, keyOf, posFromFen } from '../src/core/chess';

const PROFILES: BotProfile[] = ['fast', 'dirty-flag', 'human2200', 'machinegun'];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('часы', () => {
  it('списывают время только с активной стороны', () => {
    let now = 0;
    const c = new Clocks(15000, () => now);
    c.start('white');
    now = 3000;
    c.tick();
    expect(c.get('white')).toBe(12000);
    expect(c.get('black')).toBe(15000);
  });

  it('переключение отдаёт часы сопернику и добирает потраченное', () => {
    let now = 0;
    const c = new Clocks(10000, () => now);
    c.start('white');
    now = 2000;
    c.switchTo('black'); // белые подумали 2 секунды
    expect(c.get('white')).toBe(8000);
    now = 3500;
    c.tick();
    expect(c.get('white'), 'часы белых стоят').toBe(8000);
    expect(c.get('black')).toBe(8500);
  });

  it('время не уходит в минус и флаг фиксируется', () => {
    let now = 0;
    const c = new Clocks(5000, () => now);
    c.start('black');
    now = 9000;
    c.tick();
    expect(c.get('black')).toBe(0);
    expect(c.flagged()).toBe('black');
  });

  it('до старта флага нет', () => {
    const c = new Clocks(5000, () => 0);
    expect(c.flagged()).toBeNull();
    expect(c.activeColor()).toBeNull();
  });

  it('серия ходов списывает время каждой стороне отдельно', () => {
    let now = 0;
    const c = new Clocks(10000, () => now);
    c.start('white');
    now = 1000;
    c.switchTo('black'); // белые: 1.0 с
    now = 1400;
    c.switchTo('white'); // чёрные: 0.4 с
    now = 2100;
    c.switchTo('black'); // белые: ещё 0.7 с
    expect(c.get('white')).toBeCloseTo(10000 - 1700, 6);
    expect(c.get('black')).toBeCloseTo(10000 - 400, 6);
  });

  it('формат часов', () => {
    expect(formatClock(15000)).toBe('15.0');
    expect(formatClock(9500)).toBe('9.50');
    expect(formatClock(-20)).toBe('0.00');
  });
});

describe('профили ботов', () => {
  it('все четыре профиля описаны', () => {
    expect(Object.keys(BOT_CONFIGS).sort()).toEqual(
      ['dirty-flag', 'fast', 'human2200', 'machinegun'].sort(),
    );
  });

  it('задержки различаются: пулемёт быстрее человека 2200', () => {
    expect(BOT_CONFIGS.machinegun.maxDelayMs).toBeLessThan(BOT_CONFIGS.human2200.minDelayMs);
    expect(BOT_CONFIGS['dirty-flag'].maxDelayMs).toBeLessThan(BOT_CONFIGS.human2200.minDelayMs);
  });

  it('вероятность зевка у человека 2200 самая низкая', () => {
    const others = PROFILES.filter((p) => p !== 'human2200');
    for (const p of others) {
      expect(BOT_CONFIGS[p].blunderChance).toBeGreaterThan(BOT_CONFIGS.human2200.blunderChance);
    }
  });

  it('задержка попадает в границы профиля', () => {
    const rnd = lcg(7);
    for (const p of PROFILES) {
      for (let i = 0; i < 200; i++) {
        const d = botDelay(p, rnd);
        expect(d).toBeGreaterThanOrEqual(BOT_CONFIGS[p].minDelayMs);
        expect(d).toBeLessThanOrEqual(BOT_CONFIGS[p].maxDelayMs);
      }
    }
  });
});

describe('оценка ходов', () => {
  it('мат оценивается выше всего', () => {
    // Мат в один: Qa8#. Чёрный король h8 заперт своими пешками.
    const pos = posFromFen('7k/5ppp/8/8/8/8/8/Q3K3 w - - 0 1');
    const mate = allLegalMoves(pos).find((m) => keyOf(m.from) === 'a1' && keyOf(m.to) === 'a8');
    expect(mate).toBeDefined();
    expect(scoreMove(pos, mate!, BOT_CONFIGS.human2200)).toBe(1000);
  });

  it('взятие ферзя ценится выше взятия пешки', () => {
    // Ладья d4 может взять и ферзя d7, и пешку e4.
    const pos = posFromFen('7k/3q4/8/8/3Rp3/8/8/K7 w - - 0 1');
    const moves = allLegalMoves(pos);
    const takeQueen = moves.find((m) => keyOf(m.from) === 'd4' && keyOf(m.to) === 'd7')!;
    const takePawn = moves.find((m) => keyOf(m.from) === 'd4' && keyOf(m.to) === 'e4')!;
    expect(takeQueen).toBeDefined();
    expect(takePawn).toBeDefined();
    const cfg = BOT_CONFIGS.human2200;
    expect(scoreMove(pos, takeQueen, cfg)).toBeGreaterThan(scoreMove(pos, takePawn, cfg));
  });
});

describe('выбор хода ботом', () => {
  it('всегда возвращает легальный ход из стартовой позиции', () => {
    const rnd = lcg(99);
    for (const p of PROFILES) {
      const pos = posFromFen(INITIAL_FEN);
      const legal = new Set(allLegalMoves(pos).map((m) => `${keyOf(m.from)}${keyOf(m.to)}`));
      for (let i = 0; i < 100; i++) {
        const move = chooseMove(pos, p, rnd);
        expect(move, p).not.toBeNull();
        expect(legal.has(`${keyOf(move!.from)}${keyOf(move!.to)}`), p).toBe(true);
      }
    }
  });

  it('без легальных ходов возвращает null', () => {
    // Мат: у чёрных ходов нет.
    const pos = posFromFen('Q6k/5ppp/8/8/8/8/8/4K3 b - - 0 1');
    expect(chooseMove(pos, 'fast', lcg(1))).toBeNull();
  });

  it('партия бот против бота доигрывается без нелегальных ходов', () => {
    const rnd = lcg(2024);
    for (const p of PROFILES) {
      const pos = posFromFen(INITIAL_FEN);
      let plies = 0;
      while (!pos.isEnd() && plies < 120) {
        const move = chooseMove(pos, p, rnd);
        if (!move) break;
        expect(pos.isLegal(move), `${p}, полуход ${plies}`).toBe(true);
        pos.play(move);
        plies++;
      }
      expect(plies).toBeGreaterThan(0);
    }
  }, 60000);

  it('человек 2200 находит мат в один', () => {
    const rnd = lcg(5);
    const pos = posFromFen('7k/5ppp/8/8/8/8/8/Q3K3 w - - 0 1');
    let found = 0;
    for (let i = 0; i < 40; i++) {
      const move = chooseMove(pos, 'human2200', rnd)!;
      if (keyOf(move.to) === 'a8') found++;
    }
    // Зевки профиля — 4%, так что мат должен находиться почти всегда.
    expect(found).toBeGreaterThan(30);
  });
});
