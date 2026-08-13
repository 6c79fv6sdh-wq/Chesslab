import { describe, it, expect } from 'vitest';
import { deltaAnswer, generateDeltaTask, type DeltaTask } from '../src/modules/reaction-logic';
import { posFromFen } from '../src/core/chess';

/**
 * «Изменения позиции»: ученик сравнивает позицию до и после хода соперника
 * и называет клетку. Вопросов два — куда фигура пришла и откуда ушла, — и
 * оба обязаны иметь ровно один правильный ответ. Рокировка двигает две
 * фигуры, взятие на проходе убирает пешку с третьего поля: на таких ходах
 * вопрос «откуда?» честно неоднозначен, и в задания они попадать не должны.
 */

/** Детерминированный генератор: тест обязан падать воспроизводимо. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sample(count: number, seed = 12345): DeltaTask[] {
  const rnd = seeded(seed);
  const out: DeltaTask[] = [];
  for (let i = 0; i < count; i++) {
    const t = generateDeltaTask(rnd);
    if (t) out.push(t);
  }
  return out;
}

describe('generateDeltaTask: корректность заданий', () => {
  const tasks = sample(200);

  it('генератор вообще выдаёт задания', () => {
    expect(tasks.length).toBeGreaterThan(150);
  });

  it('позиции до и после разбираются как валидные', () => {
    for (const t of tasks) {
      expect(() => posFromFen(t.fen)).not.toThrow();
      expect(() => posFromFen(t.afterFen)).not.toThrow();
    }
  });

  it('ход соответствует полям from/to', () => {
    for (const t of tasks) {
      expect(t.moveUci.slice(0, 2)).toBe(t.from);
      expect(t.moveUci.slice(2, 4)).toBe(t.to);
      expect(t.from).not.toBe(t.to);
    }
  });

  it('ответ соответствует заданному вопросу', () => {
    for (const t of tasks) {
      expect(deltaAnswer(t)).toBe(t.direction === 'to' ? t.to : t.from);
    }
  });

  /**
   * Ключевая проверка: между позициями изменились ровно две клетки — одна
   * опустела, одна получила фигуру. Тогда и «куда?», и «откуда?» имеют
   * единственный ответ, а рокировка и взятие на проходе отсеяны.
   */
  it('меняются ровно две клетки: одна опустела, одна занята', () => {
    for (const t of tasks) {
      const before = posFromFen(t.fen);
      const after = posFromFen(t.afterFen);
      const vacated: string[] = [];
      const filled: string[] = [];
      for (let sq = 0; sq < 64; sq++) {
        const a = before.board.get(sq as never);
        const b = after.board.get(sq as never);
        const same = a && b ? a.role === b.role && a.color === b.color : a === b;
        if (same) continue;
        const file = 'abcdefgh'[sq % 8];
        const key = `${file}${Math.floor(sq / 8) + 1}`;
        if (a && !b) vacated.push(key);
        else filled.push(key);
      }
      expect(vacated).toEqual([t.from]);
      expect(filled).toEqual([t.to]);
    }
  });

  it('ходит соперник — ученик смотрит с другой стороны', () => {
    for (const t of tasks) {
      const before = posFromFen(t.fen);
      expect(t.userColor).not.toBe(before.turn);
    }
  });

  it('встречаются оба вопроса, а не один и тот же', () => {
    const dirs = new Set(tasks.map((t) => t.direction));
    expect(dirs).toEqual(new Set(['to', 'from']));
    const toCount = tasks.filter((t) => t.direction === 'to').length;
    // Примерно поровну: перекос выдал бы ошибку в выборе вопроса.
    expect(toCount).toBeGreaterThan(tasks.length * 0.3);
    expect(toCount).toBeLessThan(tasks.length * 0.7);
  });

  it('направление можно задать явно — для отладки и тестов', () => {
    const rnd = seeded(7);
    for (let i = 0; i < 20; i++) {
      expect(generateDeltaTask(rnd, 400, 'from')?.direction).toBe('from');
      expect(generateDeltaTask(rnd, 400, 'to')?.direction).toBe('to');
    }
  });
});
