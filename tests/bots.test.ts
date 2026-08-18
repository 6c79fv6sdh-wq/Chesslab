import { describe, it, expect } from 'vitest';
import { BOTS, DEFAULT_BOT, MAX_CANDIDATES, bot, sampleByTemperature } from '../src/core/bots';
import { BEGINNER_PROFILE, STUDENT_PROFILE } from '../src/core/blind-bot';

/**
 * Слабые боты сделаны температурой по политике Maia, а не подмешиванием
 * случайных зевков. Выбор идёт по МЕСТУ кандидата в списке (первый —
 * самый вероятный ход человека), потому что при `nodes 1` оценки у lc0
 * почти одинаковые и сортировать по ним бесполезно — см. комментарий в
 * bots.ts. Отсюда и проверки: нулевая температура берёт первого, высокая
 * даёт разброс, но никогда не выходит за список кандидатов сети.
 */

const cands = [
  { move: 'e2e4', score: 40 },
  { move: 'd2d4', score: 20 },
  { move: 'g1f3', score: 10 },
  { move: 'a2a3', score: -60 },
];

describe('роспись ботов', () => {
  it('идентификаторы уникальны', () => {
    const ids = BOTS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('бот по умолчанию существует', () => {
    expect(bot(DEFAULT_BOT).id).toBe(DEFAULT_BOT);
  });

  it('неизвестный бот откатывается на дефолтного, а не падает', () => {
    expect(bot('нет-такого').id).toBe(DEFAULT_BOT);
  });

  it('есть три слабых бота на Maia (температурой, не сетью)', () => {
    const weak = BOTS.filter((b) => b.kind === 'maia' && (b.rating === null || b.rating <= 1000));
    expect(weak.length).toBe(3);
    // Все обязаны иметь сеть и температуру: без неё это была бы обычная Maia.
    for (const b of weak) {
      expect(b.net, b.id).toBeTruthy();
      expect(b.temperature ?? 0, b.id).toBeGreaterThan(0);
    }
  });

  it('температура убывает по лестнице Maia: Нейрофилософ > Майкл > Наполеон', () => {
    const novice = bot('maia-novice');
    const eight = bot('maia-800');
    const thousand = bot('maia-1000');
    expect(novice.temperature!).toBeGreaterThan(eight.temperature!);
    expect(eight.temperature!).toBeGreaterThan(thousand.temperature!);
  });

  it('у каждого бота есть человеческое имя и пояснение', () => {
    for (const b of BOTS) {
      expect(b.name.length, b.id).toBeGreaterThan(2);
      expect(b.note.length, b.id).toBeGreaterThan(10);
    }
  });

  it('у каждого бота есть слаг аватара, и слаги уникальны', () => {
    const slugs = BOTS.map((b) => b.avatar);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const b of BOTS) {
      // Только латиница/цифры/дефис: слаг идёт прямо в имя файла.
      expect(b.avatar, b.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('слаг аватара не равен id — id заморожен, картинки нет', () => {
    // id лежит в каждой сохранённой партии (resumeGame берёт соперника
    // по нему), поэтому переименовать его нельзя. Слаг живёт отдельно,
    // чтобы файл назывался по персонажу, а не по движку под ним.
    for (const b of BOTS) expect(b.avatar, b.id).not.toBe(b.id);
  });

  it('maia-боты возят сеть, stockfish-боты — нет', () => {
    for (const b of BOTS) {
      if (b.kind === 'maia') expect(b.net, b.id).toBeTruthy();
      else expect(b.net, b.id).toBeUndefined();
    }
  });

  it('blind-боты идут раньше maia-ботов — они слабейшие', () => {
    const ids = BOTS.map((b) => b.id);
    const lastBlind = ids.lastIndexOf('blind-student');
    const firstMaia = ids.indexOf('maia-novice');
    expect(lastBlind).toBeGreaterThanOrEqual(0);
    expect(firstMaia).toBeGreaterThan(lastBlind);
  });

  it('«Принцесса» той же механики, что «Щенок Пижон», но внимательнее', () => {
    // Тот же тип слепоты (см. STUDENT_PROFILE в blind-bot.ts) — сильнее
    // не за счёт другой идеи игры, а за счёт того, что чаще замечает
    // найденную угрозу.
    expect(STUDENT_PROFILE.seeOwnMateChance).toBeGreaterThan(BEGINNER_PROFILE.seeOwnMateChance);
    expect(STUDENT_PROFILE.seeOpponentMateChance).toBeGreaterThan(BEGINNER_PROFILE.seeOpponentMateChance);
    expect(STUDENT_PROFILE.seeMaterialThreatChance).toBeGreaterThan(
      BEGINNER_PROFILE.seeMaterialThreatChance,
    );

    const student = bot('blind-student');
    const beginner = bot('blind-beginner');
    expect(student.rating!).toBeGreaterThan(beginner.rating!);
    expect(student.blindProfile).toBe(STUDENT_PROFILE);
    expect(beginner.blindProfile).toBe(BEGINNER_PROFILE);
  });
});

describe('sampleByTemperature', () => {
  it('нулевая температура — всегда первый кандидат сети', () => {
    for (let i = 0; i < 20; i++) {
      expect(sampleByTemperature(cands, 0, Math.random)).toBe('e2e4');
    }
  });

  it('порядок кандидатов важнее их оценок', () => {
    // Первый в списке — самый вероятный человеческий ход, даже если
    // оценка у него хуже: на nodes 1 оценки почти не различаются.
    const odd = [
      { move: 'b1c3', score: -5 },
      { move: 'e2e4', score: 900 },
    ];
    expect(sampleByTemperature(odd, 0, Math.random)).toBe('b1c3');
  });

  it('пустой список кандидатов — null, а не исключение', () => {
    expect(sampleByTemperature([], 1.5, Math.random)).toBeNull();
  });

  it('единственный кандидат берётся при любой температуре', () => {
    expect(sampleByTemperature([{ move: 'e2e4', score: 0 }], 5, Math.random)).toBe('e2e4');
  });

  it('высокая температура даёт разброс', () => {
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(sampleByTemperature(cands, 1.6, rnd)!);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('выбор никогда не выходит за список кандидатов сети', () => {
    const legal = new Set(cands.map((c) => c.move));
    for (let i = 0; i < 300; i++) {
      expect(legal.has(sampleByTemperature(cands, 2.0, Math.random)!)).toBe(true);
    }
  });

  it('пул кандидатов ограничен даже без явного параметра', () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ move: `m${i}`, score: -i }));
    for (let i = 0; i < 300; i++) {
      const picked = sampleByTemperature(long, 5, Math.random)!;
      expect(Number(picked.slice(1))).toBeLessThan(MAX_CANDIDATES);
    }
  });

  it('самый вероятный ход всё равно берётся чаще прочих', () => {
    const counts = new Map<string, number>();
    const runs = 600;
    for (let i = 0; i < runs; i++) {
      const m = sampleByTemperature(cands, 1.5, Math.random)!;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const top = counts.get('e2e4') ?? 0;
    for (const [move, n] of counts) {
      if (move !== 'e2e4') expect(top, move).toBeGreaterThan(n);
    }
  });

  it('чем выше температура, тем реже первый ход', () => {
    const share = (t: number) => {
      let first = 0;
      const runs = 800;
      for (let i = 0; i < runs; i++) {
        if (sampleByTemperature(cands, t, Math.random) === 'e2e4') first++;
      }
      return first / runs;
    };
    expect(share(0.5)).toBeGreaterThan(share(1.5));
    expect(share(1.5)).toBeGreaterThan(share(3));
  });

  it('шире пул — глубже в хвост человеческих ходов', () => {
    const long = [
      ...cands,
      { move: 'h2h4', score: -80 },
      { move: 'g2g4', score: -90 },
    ];
    const narrow = new Set<string>();
    const wide = new Set<string>();
    for (let i = 0; i < 400; i++) {
      narrow.add(sampleByTemperature(long, 2.6, Math.random, 4)!);
      wide.add(sampleByTemperature(long, 2.6, Math.random, 6)!);
    }
    expect(narrow.has('g2g4')).toBe(false);
    expect(wide.size).toBeGreaterThan(narrow.size);
  });
});
