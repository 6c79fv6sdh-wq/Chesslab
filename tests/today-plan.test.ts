import { describe, it, expect } from 'vitest';
import {
  buildDayPlan,
  dayKey,
  planFor,
  sessionCountsToday,
} from '../src/modules/today-plan';
import { DEFAULT_CALIBRATION } from '../src/core/settings';
import type { ModuleId, SessionRecord } from '../src/core/db';

function session(module: ModuleId, startedAt: number, ended = true): SessionRecord {
  return {
    id: `${module}-${startedAt}`,
    module,
    mode: 'test',
    startedAt,
    endedAt: ended ? startedAt + 60_000 : null,
    calibration: DEFAULT_CALIBRATION,
    summary: {},
  };
}

/** Полдень указанного дня по локальному времени. */
function noon(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 12, 0, 0);
}

describe('dayKey: день считается по локальному времени', () => {
  it('склеивает дату в YYYY-MM-DD с ведущими нулями', () => {
    expect(dayKey(noon(2026, 3, 7))).toBe('2026-03-07');
    expect(dayKey(noon(2026, 12, 31))).toBe('2026-12-31');
  });

  it('поздний вечер и раннее утро — разные дни', () => {
    expect(dayKey(new Date(2026, 4, 10, 23, 59))).toBe('2026-05-10');
    expect(dayKey(new Date(2026, 4, 11, 0, 1))).toBe('2026-05-11');
  });
});

describe('planFor: состав тренировки на день', () => {
  it('всегда три шага', () => {
    for (let d = 1; d <= 28; d++) expect(planFor(noon(2026, 6, d))).toHaveLength(3);
  });

  it('разминка и реакция каждый день', () => {
    for (let d = 1; d <= 28; d++) {
      const mods = planFor(noon(2026, 6, d)).map((s) => s.module);
      expect(mods[0], `день ${d}`).toBe('motorics');
      expect(mods[1], `день ${d}`).toBe('reaction');
    }
  });

  it('план на один и тот же день не меняется от вызова к вызову', () => {
    const a = planFor(new Date(2026, 5, 15, 9, 30));
    const b = planFor(new Date(2026, 5, 15, 21, 45));
    expect(a.map((s) => s.module)).toEqual(b.map((s) => s.module));
  });

  it('третий шаг чередуется, а не залипает на одном модуле', () => {
    const thirds = new Set<string>();
    for (let d = 1; d <= 9; d++) thirds.add(planFor(noon(2026, 6, d))[2].module);
    expect(thirds.size).toBeGreaterThan(1);
    for (const m of thirds) expect(['premove', 'openings', 'scramble']).toContain(m);
  });

  it('за три подряд идущих дня третий шаг ни разу не повторяется', () => {
    const thirds = [1, 2, 3].map((d) => planFor(noon(2026, 6, d))[2].module);
    expect(new Set(thirds).size).toBe(3);
  });

  it('каждый шаг ведёт на существующую вкладку своего модуля', () => {
    for (const step of planFor(noon(2026, 6, 1))) expect(step.tab).toBe(step.module);
  });
});

describe('sessionCountsToday: что засчитывается за день', () => {
  const today = noon(2026, 6, 10);

  it('засчитывает завершённую сессию этого дня', () => {
    expect(sessionCountsToday(session('motorics', noon(2026, 6, 10).getTime()), today)).toBe(true);
  });

  it('не засчитывает вчерашнюю', () => {
    expect(sessionCountsToday(session('motorics', noon(2026, 6, 9).getTime()), today)).toBe(false);
  });

  it('не засчитывает брошенную на середине (endedAt пустой)', () => {
    const s = session('motorics', noon(2026, 6, 10).getTime(), false);
    expect(sessionCountsToday(s, today)).toBe(false);
  });
});

describe('buildDayPlan: отметки берутся из записанных замеров', () => {
  const today = noon(2026, 6, 10);

  it('на пустой базе не пройдено ничего, следующий шаг — первый', () => {
    const plan = buildDayPlan([], today);
    expect(plan.doneCount).toBe(0);
    expect(plan.steps.every((s) => !s.done)).toBe(true);
    expect(plan.next?.module).toBe('motorics');
    expect(plan.day).toBe('2026-06-10');
  });

  it('пройденный модуль отмечается, следующим становится непройденный', () => {
    const plan = buildDayPlan([session('motorics', today.getTime())], today);
    expect(plan.steps[0].done).toBe(true);
    expect(plan.doneCount).toBe(1);
    expect(plan.next?.module).toBe('reaction');
  });

  it('вчерашние тренировки на сегодняшний план не влияют', () => {
    const plan = buildDayPlan([session('motorics', noon(2026, 6, 9).getTime())], today);
    expect(plan.doneCount).toBe(0);
    expect(plan.next?.module).toBe('motorics');
  });

  it('когда пройдено всё, следующего шага нет', () => {
    const sessions = planFor(today).map((s) => session(s.module, today.getTime()));
    const plan = buildDayPlan(sessions, today);
    expect(plan.doneCount).toBe(3);
    expect(plan.next).toBeNull();
  });

  it('несколько сессий одного модуля не считаются как несколько шагов', () => {
    const sessions = [
      session('motorics', today.getTime()),
      session('motorics', today.getTime() + 1000),
      session('motorics', today.getTime() + 2000),
    ];
    expect(buildDayPlan(sessions, today).doneCount).toBe(1);
  });

  it('модуль не из плана дня галочек не добавляет', () => {
    const plan = planFor(today);
    const outsider = (['premove', 'openings', 'scramble'] as ModuleId[]).find(
      (m) => !plan.some((s) => s.module === m),
    )!;
    expect(buildDayPlan([session(outsider, today.getTime())], today).doneCount).toBe(0);
  });
});
