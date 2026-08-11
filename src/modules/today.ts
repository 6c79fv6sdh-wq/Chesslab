import type { AppContext, Unmount } from '../main';
import { el, panel } from '../core/ui';
import { allMeasurements, allSessions } from '../core/db';
import { fmtDuration } from '../core/stats';
import { markPlanNavigation } from '../core/session';
import { buildDayPlan, sessionCountsToday, type DayPlan } from './today-plan';

/**
 * «Сегодня» — точка входа в тренировку. Показывает назначенный на день
 * состав из уже существующих модулей и одну кнопку, чтобы начать.
 *
 * Галочки не хранятся отдельно: шаг считается пройденным, когда его
 * сессия записана в базу и полностью доведена до конца (см.
 * sessionIsComplete в today-plan.ts) — ровно та связка
 * «тренировка → измерение → прогресс», ради которой вкладка и сделана.
 */

function stepRow(step: DayPlan['steps'][number], index: number, go: (tab: string) => void): HTMLElement {
  const mark = el('span', { class: `plan-mark${step.done ? ' done' : ''}` }, [
    step.done ? '✓' : String(index + 1),
  ]);
  const goBtn = el('button', { class: 'btn plan-go', type: 'button' }, [
    step.done ? 'Повторить' : 'Перейти',
  ]);
  goBtn.addEventListener('click', () => go(step.tab));

  return el('div', { class: `plan-step${step.done ? ' done' : ''}` }, [
    mark,
    el('div', { class: 'plan-text' }, [
      el('strong', {}, [step.label]),
      el('span', {}, [step.detail]),
    ]),
    goBtn,
  ]);
}

export function mountToday(root: HTMLElement, _ctx: AppContext): Unmount {
  let disposed = false;

  root.append(el('h1', {}, ['Сегодня']));

  const planHost = el('div', {});
  const summaryHost = el('div', {});
  root.append(planHost, summaryHost);

  function go(tab: string): void {
    // Ставим флаг ПЕРЕД переходом: модуль на своей стороне считает его на
    // маунте и по нему решает, показывать ли потом «Следующее упражнение».
    markPlanNavigation();
    location.hash = `#${tab}`;
  }

  async function render(): Promise<void> {
    const now = new Date();
    const [sessions, measurements] = await Promise.all([allSessions(), allMeasurements()]);
    if (disposed) return;

    const plan = buildDayPlan(sessions, now);
    const total = plan.steps.length;

    const startBtn = el('button', { class: 'btn primary plan-start', type: 'button' }, [
      plan.next ? 'Начать тренировку' : 'Тренировка на сегодня пройдена',
    ]);
    if (plan.next) startBtn.addEventListener('click', () => go(plan.next!.tab));
    else (startBtn as HTMLButtonElement).disabled = true;

    const progressBar = el('div', {});
    progressBar.style.width = `${(plan.doneCount / total) * 100}%`;

    planHost.innerHTML = '';
    planHost.append(
      panel('Тренировка на сегодня', [
        el('p', { class: 'plan-count' }, [`Пройдено ${plan.doneCount} из ${total}`]),
        el('div', { class: 'progress' }, [progressBar]),
        el('div', { class: 'plan-steps' }, plan.steps.map((s, i) => stepRow(s, i, go))),
        startBtn,
      ]),
    );

    // Итог дня считаем по тем же сессиям, что и вкладка «Прогресс»:
    // одно число не должно расходиться между экранами. Здесь — все
    // сегодняшние сессии (sessionCountsToday), включая прерванные:
    // «сколько всего успел сделать» шире, чем строгая отметка о
    // выполнении модуля в списке выше.
    const todaySessions = sessions.filter((s) => sessionCountsToday(s, now));
    const todaySessionIds = new Set(todaySessions.map((s) => s.id));
    const todayMeasurements = measurements.filter((m) => todaySessionIds.has(m.sessionId));
    const totalMs = todaySessions.reduce(
      (sum, s) => sum + (s.endedAt !== null ? Math.max(0, s.endedAt - s.startedAt) : 0),
      0,
    );

    summaryHost.innerHTML = '';
    summaryHost.append(
      panel('Итог дня', [
        el('div', { class: 'metrics' }, [
          metric('Модулей', `${plan.doneCount} / ${total}`),
          metric('Заданий', String(todayMeasurements.length)),
          metric('Время тренировки', fmtDuration(totalMs)),
        ]),
        el('p', { class: 'hint' }, [
          todayMeasurements.length
            ? 'Полная история и разрезы — на вкладке «Прогресс».'
            : 'Сегодня замеров ещё нет. Начни тренировку — числа появятся здесь сами.',
        ]),
      ]),
    );
  }

  function metric(k: string, v: string): HTMLElement {
    return el('div', { class: 'metric' }, [
      el('span', { class: 'metric-k' }, [k]),
      el('span', { class: 'metric-v' }, [v]),
    ]);
  }

  void render();

  // Возвращаясь с модуля, ученик должен увидеть свежую галочку, а не
  // состояние, снятое при первом открытии вкладки.
  const onFocus = () => void render();
  window.addEventListener('focus', onFocus);

  return () => {
    disposed = true;
    window.removeEventListener('focus', onFocus);
  };
}
