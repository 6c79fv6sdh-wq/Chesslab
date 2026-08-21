import { describe, it, expect } from 'vitest';
import {
  buildDayPlan,
  dayKey,
  planFor,
  sessionCountsToday,
  sessionIsComplete,
  stepAfter,
} from '../src/modules/today-plan';
import { DEFAULT_CALIBRATION } from '../src/core/settings';
import type { ModuleId, SessionRecord } from '../src/core/db';
import { REPS as MOTORICS_REPS } from '../src/modules/motorics';
import { TASKS_PER_SESSION as PREMOVE_TASKS } from '../src/modules/premove';
import { TASKS_PER_SESSION as REACTION_TASKS } from '../src/modules/reaction';
import { LINES_PER_SESSION as OPENINGS_LINES } from '../src/modules/openings';

/**
 * Summary полностью пройденной сессии — как её реально пишет каждый
 * модуль при завершении session.finish(). Используются настоящие
 * экспортированные константы модулей (MOTORICS_REPS и т.п.), а не
 * скопированные числа: если порог когда-нибудь изменится в самом модуле,
 * а today-plan.ts забудут поправить, тесты ниже это поймают.
 */
function completeSummary(module: ModuleId): Record<string, number | string | null> {
  switch (module) {
    case 'motorics':
      return { reps: MOTORICS_REPS };
    case 'premove':
      return { attempts: PREMOVE_TASKS };
    case 'reaction':
      return { attempts: REACTION_TASKS };
    case 'openings':
      return { linesDone: OPENINGS_LINES };
    case 'scramble':
      return { outcome: 'mate-user' };
  }
}

function session(
  module: ModuleId,
  startedAt: number,
  opts: { ended?: boolean; summary?: Record<string, number | string | null>; mode?: string } = {},
): SessionRecord {
  const ended = opts.ended ?? true;
  return {
    id: `${module}-${startedAt}-${Math.random().toString(36).slice(2)}`,
    module,
    mode: opts.mode ?? 'test',
    startedAt,
    endedAt: ended ? startedAt + 60_000 : null,
    calibration: DEFAULT_CALIBRATION,
    summary: opts.summary ?? (ended ? completeSummary(module) : {}),
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
    const s = session('motorics', noon(2026, 6, 10).getTime(), { ended: false });
    expect(sessionCountsToday(s, today)).toBe(false);
  });

  it('засчитывает и НЕполную сессию — это мягкая проверка «была активность»', () => {
    const s = session('motorics', noon(2026, 6, 10).getTime(), { summary: { reps: 5 } });
    expect(sessionCountsToday(s, today)).toBe(true);
  });
});

describe('sessionIsComplete: реальные критерии полного прохождения', () => {
  it('моторика — ровно 30 повторов, не меньше', () => {
    expect(sessionIsComplete(session('motorics', 0, { summary: { reps: MOTORICS_REPS } }))).toBe(true);
    expect(sessionIsComplete(session('motorics', 0, { summary: { reps: MOTORICS_REPS - 1 } }))).toBe(false);
    expect(sessionIsComplete(session('motorics', 0, { summary: { reps: 0 } }))).toBe(false);
    expect(sessionIsComplete(session('motorics', 0, { summary: {} }))).toBe(false);
  });

  it('premove — ровно 8 заданий сессии', () => {
    expect(sessionIsComplete(session('premove', 0, { summary: { attempts: PREMOVE_TASKS } }))).toBe(true);
    expect(sessionIsComplete(session('premove', 0, { summary: { attempts: PREMOVE_TASKS - 1 } }))).toBe(
      false,
    );
  });

  it('реакция — ровно 10 заданий сессии (порог отличается от premove)', () => {
    expect(sessionIsComplete(session('reaction', 0, { summary: { attempts: REACTION_TASKS } }))).toBe(true);
    expect(sessionIsComplete(session('reaction', 0, { summary: { attempts: REACTION_TASKS - 1 } }))).toBe(
      false,
    );
    // Модули не путают чужие пороги: 8 заданий (порог premove) для
    // реакции (порог 10) сессией не считается.
    expect(sessionIsComplete(session('reaction', 0, { summary: { attempts: PREMOVE_TASKS } }))).toBe(false);
  });

  it('«Скан конём» (mode knight-scan) — свой порог 20, а не общий реакционный 10', () => {
    expect(
      sessionIsComplete(session('reaction', 0, { mode: 'knight-scan', summary: { attempts: 20 } })),
    ).toBe(true);
    expect(
      sessionIsComplete(session('reaction', 0, { mode: 'knight-scan', summary: { attempts: REACTION_TASKS } })),
    ).toBe(false);
    // И наоборот: 20 заданий у обычного режима «Тактики» не считаются
    // завершением — там порог REACTION_TASKS.
    expect(sessionIsComplete(session('reaction', 0, { summary: { attempts: 20 } }))).toBe(false);
  });

  it('дебюты — ровно 4 полные линии, а не количество узлов', () => {
    expect(sessionIsComplete(session('openings', 0, { summary: { linesDone: OPENINGS_LINES } }))).toBe(
      true,
    );
    expect(
      sessionIsComplete(session('openings', 0, { summary: { linesDone: OPENINGS_LINES - 1 } })),
    ).toBe(false);
    // Много узлов, но линия одна не в счёт — «полноценность» именно в
    // числе ЗАВЕРШЁННЫХ линий, не в общем числе ходов.
    expect(
      sessionIsComplete(session('openings', 0, { summary: { nodes: 40, linesDone: 1 } })),
    ).toBe(false);
  });

  it('цейтнот — партия доиграна до конца, а не сдана досрочно', () => {
    for (const outcome of ['mate-user', 'mate-bot', 'draw', 'flag-user', 'flag-bot']) {
      expect(sessionIsComplete(session('scramble', 0, { summary: { outcome } })), outcome).toBe(true);
    }
    expect(sessionIsComplete(session('scramble', 0, { summary: { outcome: 'aborted' } }))).toBe(false);
    expect(sessionIsComplete(session('scramble', 0, { summary: {} }))).toBe(false);
  });
});

describe('stepAfter: позиционный следующий шаг для «Следующее упражнение →»', () => {
  const today = noon(2026, 6, 10);

  it('после первого шага — второй (Моторика → Реакция)', () => {
    expect(stepAfter('motorics', today)?.module).toBe('reaction');
  });

  it('после последнего шага плана — null', () => {
    const plan = planFor(today);
    expect(stepAfter(plan[2].module, today)).toBeNull();
  });

  it('не зависит от того, пройден ли шаг — чисто позиционно', () => {
    // planFor тот же список, что и в buildDayPlan; stepAfter не смотрит
    // на выполнение вообще, только на порядок.
    const a = stepAfter('motorics', today);
    const b = stepAfter('motorics', today);
    expect(a).toEqual(b);
  });

  it('модуль не из сегодняшнего плана — null', () => {
    const plan = planFor(today).map((s) => s.module);
    const outsider = (['premove', 'openings', 'scramble'] as ModuleId[]).find((m) => !plan.includes(m));
    if (outsider) expect(stepAfter(outsider, today)).toBeNull();
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

  it('полноценно пройденный модуль отмечается, следующим становится непройденный', () => {
    const plan = buildDayPlan([session('motorics', today.getTime())], today);
    expect(plan.steps[0].done).toBe(true);
    expect(plan.doneCount).toBe(1);
    expect(plan.next?.module).toBe('reaction');
  });

  it('прерванная на середине сессия галочку НЕ ставит (item 2)', () => {
    const s = session('motorics', today.getTime(), { summary: { reps: 12 } });
    const plan = buildDayPlan([s], today);
    expect(plan.steps[0].done).toBe(false);
    expect(plan.doneCount).toBe(0);
    // Но при этом попытка сегодня была — sessionCountsToday это увидит
    // отдельно (используется для «Итог дня», не для галочки).
    expect(sessionCountsToday(s, today)).toBe(true);
  });

  it('вчерашние тренировки на сегодняшний план не влияют', () => {
    const plan = buildDayPlan([session('motorics', noon(2026, 6, 9).getTime())], today);
    expect(plan.doneCount).toBe(0);
    expect(plan.next?.module).toBe('motorics');
  });

  it('когда пройдено всё (полноценно), следующего шага нет', () => {
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

  it('одна неполная и одна полная сессия одного модуля — модуль засчитан', () => {
    const sessions = [
      session('motorics', today.getTime(), { summary: { reps: 5 } }),
      session('motorics', today.getTime() + 1000),
    ];
    expect(buildDayPlan(sessions, today).steps[0].done).toBe(true);
  });

  it('модуль не из плана дня галочек не добавляет', () => {
    const plan = planFor(today).map((s) => s.module);
    const outsider = (['premove', 'openings', 'scramble'] as ModuleId[]).find((m) => !plan.includes(m))!;
    expect(buildDayPlan([session(outsider, today.getTime())], today).doneCount).toBe(0);
  });
});
