import { describe, it, expect } from 'vitest';
import { buildPgn, newGameRecord, pgnTimeControl, type GameRecord } from '../src/core/games';
import { timeControl } from '../src/core/timecontrol';

/**
 * Партии сохраняются после каждого хода, и PGN пересобирается заново.
 * Значит проверять надо не «дописался ли хвост», а что готовая строка
 * читается сторонними программами: теги на месте, номера ходов верные,
 * результат совпадает с тегом Result.
 */

function game(overrides: Partial<GameRecord> = {}): GameRecord {
  const base = newGameRecord({
    profileId: 'p1',
    userColor: 'white',
    bot: { id: 'maia-1100', name: 'Майя 1100', rating: 1100, kind: 'maia' },
    timeControl: timeControl('5+3'),
  });
  return { ...base, startedAt: Date.UTC(2026, 7, 13, 12, 0, 0), ...overrides };
}

const mv = (uci: string, san: string) => ({ uci, san, spentMs: 1000, clockLeftMs: 300000 });

describe('PGN сохранённой партии', () => {
  it('несёт обязательные теги', () => {
    const pgn = buildPgn(game());
    for (const tag of ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result']) {
      expect(pgn, tag).toContain(`[${tag} `);
    }
  });

  it('ставит имя бота на его цвет', () => {
    const white = buildPgn(game({ userColor: 'white' }));
    expect(white).toContain('[White "Ученик"]');
    expect(white).toContain('[Black "Майя 1100"]');

    const black = buildPgn(game({ userColor: 'black' }));
    expect(black).toContain('[White "Майя 1100"]');
    expect(black).toContain('[Black "Ученик"]');
  });

  it('рейтинг бота попадает на его сторону', () => {
    expect(buildPgn(game({ userColor: 'white' }))).toContain('[BlackElo "1100"]');
    expect(buildPgn(game({ userColor: 'black' }))).toContain('[WhiteElo "1100"]');
  });

  it('нумерует ходы как в обычном PGN', () => {
    const g = game({
      moves: [mv('e2e4', 'e4'), mv('e7e5', 'e5'), mv('g1f3', 'Nf3')],
    });
    expect(buildPgn(g)).toContain('1. e4 e5 2. Nf3');
  });

  it('дописывает результат в конец ходов', () => {
    const g = game({ moves: [mv('e2e4', 'e4')], result: '1-0' });
    const pgn = buildPgn(g);
    expect(pgn).toContain('[Result "1-0"]');
    expect(pgn.trimEnd().endsWith('1-0')).toBe(true);
  });

  it('незаконченная партия помечена звёздочкой и без неё в ходах', () => {
    const g = game({ moves: [mv('e2e4', 'e4')] });
    expect(buildPgn(g)).toContain('[Result "*"]');
    expect(buildPgn(g).trimEnd().endsWith('e4')).toBe(true);
  });

  it('дата в формате PGN', () => {
    expect(buildPgn(game())).toMatch(/\[Date "\d{4}\.\d{2}\.\d{2}"\]/);
  });

  it('строки ходов не длиннее 80 символов', () => {
    const many = Array.from({ length: 60 }, () => mv('g1f3', 'Nf3'));
    for (const line of buildPgn(game({ moves: many })).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('тег TimeControl', () => {
  it('пишет секунды и добавку', () => {
    expect(pgnTimeControl(timeControl('5+3'))).toBe('300+3');
    expect(pgnTimeControl(timeControl('3+0'))).toBe('180+0');
  });

  it('без часов — прочерк, как требует спецификация', () => {
    expect(pgnTimeControl(timeControl('none'))).toBe('-');
  });
});

describe('новая запись партии', () => {
  it('начинается живой, без результата и с полными часами', () => {
    const g = newGameRecord({
      profileId: 'p1',
      userColor: 'white',
      bot: { id: 'maia-1000', name: 'Майя 1000', rating: 1000, kind: 'maia' },
      timeControl: timeControl('3+2'),
    });
    expect(g.status).toBe('live');
    expect(g.result).toBe('*');
    expect(g.moves).toEqual([]);
    expect(g.clockLeftMs).toEqual({ white: 180000, black: 180000 });
  });

  it('без часов остатки не заводятся вовсе', () => {
    const g = newGameRecord({
      profileId: 'p1',
      userColor: 'black',
      bot: { id: 'sf-max', name: 'Движок максимум', rating: null, kind: 'stockfish' },
      timeControl: timeControl('none'),
    });
    expect(g.clockLeftMs).toBeNull();
  });

  it('партия привязана к профилю', () => {
    const g = newGameRecord({
      profileId: 'ученик-42',
      userColor: 'white',
      bot: { id: 'sf-1400', name: 'Движок 1400', rating: 1400, kind: 'stockfish' },
      timeControl: timeControl('5+0'),
    });
    expect(g.profileId).toBe('ученик-42');
  });
});
