import type { AppContext, Unmount } from '../main';
import { el, panel } from '../core/ui';
import { allMeasurements, allSessions } from '../core/db';
import { fmtMs, median } from '../core/stats';
import { primaryLatency } from './data-summary';
import { buildDayPlan, sessionCountsToday, type DayPlan } from './today-plan';

/**
 * «Сегодня» — точка входа в тренировку. Показывает назначенный на день
 * состав из уже существующих модулей и одну кнопку, чтобы начать.
 *
 * Галочки не хранятся отдельно: шаг считается пройденным, когда его
 * сессия записана в базу. То есть отметка о выполнении и есть измерение —
 * ровно та связка «тренировка → измерение → прогресс», ради которой
 * вкладка и сделана.
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

    // Итог дня считаем по тем же замерам, что и вкладка «Прогресс»:
    // одно число не должно расходиться между экранами.
    const todaySessionIds = new Set(
      sessions.filter((s) => sessionCountsToday(s, now)).map((s) => s.id),
    );
    const todayMeasurements = measurements.filter((m) => todaySessionIds.has(m.sessionId));
    const latencies = todayMeasurements
      .map(primaryLatency)
      .filter((v): v is number => v !== null);

    summaryHost.innerHTML = '';
    summaryHost.append(
      panel('Итог дня', [
        el('div', { class: 'metrics' }, [
          metric('Заданий', String(todayMeasurements.length)),
          metric('Медиана', fmtMs(median(latencies))),
          metric('Модулей', `${plan.doneCount} / ${total}`),
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
