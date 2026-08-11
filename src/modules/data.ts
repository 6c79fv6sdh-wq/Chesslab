import type { AppContext, Unmount } from '../main';
import { el, panel, table } from '../core/ui';
import { fmtMs, fmtNum, fmtPct } from '../core/stats';
import {
  allMeasurements,
  allOpeningNodes,
  allSessions,
  clearMeasurements,
  exportBundle,
  importBundle,
  parseBundle,
  requestPersistentStorage,
  storageStatus,
  type MeasurementRecord,
  type ModuleId,
  type OpeningNodeStat,
  type SessionRecord,
} from '../core/db';
import {
  MODULE_LABELS,
  motoricsBreakdown,
  slowestNodes,
  summarizeAll,
  summarizeModule,
  type SummaryRow,
} from './data-summary';
import { REPERTOIRES } from '../data/repertoire';

function summaryTable(rows: SummaryRow[], firstHeader: string): HTMLElement {
  return table(
    [firstHeader, 'Попыток', 'Медиана', 'P90', 'Точность'],
    rows.map((r) => [
      r.key,
      String(r.attempts),
      fmtMs(r.medianMs),
      fmtMs(r.p90Ms),
      r.accuracy === null ? '—' : fmtPct(r.accuracy),
    ]),
  );
}

export function mountData(root: HTMLElement, _ctx: AppContext): Unmount {
  root.append(el('h1', {}, ['Прогресс']));

  const overviewHost = el('div', {});
  const storageHost = el('div', {});
  const perModuleHost = el('div', {});
  const motoricsHost = el('div', {});
  const openingsHost = el('div', {});
  const sessionsHost = el('div', {});
  const ioStatus = el('div', { class: 'prompt' }, ['']);
  const jsonArea = el('textarea', {
    placeholder: 'Сюда попадает экспорт. Сюда же можно вставить JSON для импорта.',
  }) as HTMLTextAreaElement;

  async function render(): Promise<void> {
    const [measurements, sessions, nodes] = await Promise.all([
      allMeasurements(),
      allSessions(),
      allOpeningNodes(),
    ]);
    renderOverview(measurements);
    void renderStorage();
    renderPerModule(measurements);
    renderMotorics(measurements);
    renderOpenings(nodes);
    renderSessions(sessions);
  }

  async function renderStorage(): Promise<void> {
    const st = await storageStatus();
    const mb = (v: number | null) => (v === null ? '—' : `${(v / 1024 / 1024).toFixed(1)} МБ`);
    storageHost.innerHTML = '';
    storageHost.append(
      el('div', { class: 'stats' }, [
        el('div', { class: 'stat' }, [
          el('span', { class: 'stat-k' }, ['Постоянное хранение']),
          el('span', { class: 'stat-v' }, [
            !st.supported ? 'не поддерживается' : st.persistent ? 'включено' : 'выключено',
          ]),
        ]),
        el('div', { class: 'stat' }, [
          el('span', { class: 'stat-k' }, ['Занято']),
          el('span', { class: 'stat-v' }, [mb(st.usageBytes)]),
        ]),
      ]),
    );
    if (st.supported && !st.persistent) {
      const ask = el('button', { class: 'btn', type: 'button' }, ['Запросить постоянное хранение']);
      ask.addEventListener('click', () => {
        void requestPersistentStorage().then(() => renderStorage());
      });
      storageHost.append(
        ask,
        el('p', { class: 'hint' }, [
          'Пока хранение не постоянное, браузер вправе удалить замеры сам — Safari на iOS делает это после семи дней без визитов. Установка на Home Screen снимает это ограничение.',
        ]),
      );
    }
  }

  function renderOverview(measurements: MeasurementRecord[]): void {
    overviewHost.innerHTML = '';
    const rows = summarizeAll(measurements);
    overviewHost.append(summaryTable(rows, 'Модуль'));
    if (!rows.length) {
      overviewHost.append(el('p', { class: 'hint' }, ['Замеров пока нет. Пройди любую сессию.']));
    }
  }

  function renderPerModule(measurements: MeasurementRecord[]): void {
    perModuleHost.innerHTML = '';
    for (const mod of Object.keys(MODULE_LABELS) as ModuleId[]) {
      const rows = summarizeModule(measurements, mod);
      if (!rows.length) continue;
      perModuleHost.append(el('h3', {}, [MODULE_LABELS[mod]]), summaryTable(rows, 'Режим'));
    }
  }

  function renderMotorics(measurements: MeasurementRecord[]): void {
    motoricsHost.innerHTML = '';
    const axes: Array<[string, 'boardSize' | 'distance' | 'direction']> = [
      ['По размеру доски', 'boardSize'],
      ['По расстоянию в клетках', 'distance'],
      ['По направлению', 'direction'],
    ];
    let any = false;
    for (const [title, axis] of axes) {
      const rows = motoricsBreakdown(measurements, axis);
      if (!rows.length) continue;
      any = true;
      motoricsHost.append(
        el('h3', {}, [title]),
        table(
          [title.replace('По ', ''), 'Попыток', 'Медиана', 'P90', 'Без промахов', 'Эффект.', 'Коррекций'],
          rows.map((r) => [
            r.key,
            String(r.attempts),
            fmtMs(r.medianMs),
            fmtMs(r.p90Ms),
            r.accuracy === null ? '—' : fmtPct(r.accuracy),
            fmtNum(r.pathEfficiency, 2),
            fmtNum(r.corrections, 1),
          ]),
        ),
      );
    }
    if (!any) motoricsHost.append(el('p', { class: 'hint' }, ['Замеров моторики пока нет.']));
  }

  function renderOpenings(nodes: OpeningNodeStat[]): void {
    openingsHost.innerHTML = '';
    const rows = slowestNodes(nodes);
    const label = (id: string) => REPERTOIRES.find((r) => r.id === id)?.label ?? id;
    openingsHost.append(
      table(
        ['Репертуар', 'Позиция до хода', 'Ход', 'Замеров', 'Медиана'],
        rows.map((r) => [
          label(r.repertoireId),
          r.path || '(начало)',
          r.expectedSan,
          String(r.samples),
          fmtMs(r.medianMs),
        ]),
      ),
    );
  }

  function renderSessions(sessions: SessionRecord[]): void {
    sessionsHost.innerHTML = '';
    const rows = [...sessions]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 25)
      .map((s) => [
        new Date(s.startedAt).toLocaleString('ru-RU'),
        MODULE_LABELS[s.module] ?? s.module,
        s.mode,
        String(s.summary.reps ?? s.summary.attempts ?? s.summary.nodes ?? s.summary.moves ?? '—'),
        String(s.summary.outcomeLabel ?? ''),
      ]);
    sessionsHost.append(table(['Начало', 'Модуль', 'Режим', 'Замеров', 'Исход'], rows));
  }

  // --- Экспорт и импорт.
  const exportBtn = el('button', { class: 'btn', type: 'button' }, ['Экспорт в поле']);
  exportBtn.addEventListener('click', () => {
    void (async () => {
      const bundle = await exportBundle();
      jsonArea.value = JSON.stringify(bundle, null, 2);
      ioStatus.textContent = `Выгружено: сессий ${bundle.sessions.length}, замеров ${bundle.measurements.length}.`;
      ioStatus.className = 'prompt verdict-ok';
    })();
  });

  const downloadBtn = el('button', { class: 'btn', type: 'button' }, ['Скачать файл']);
  downloadBtn.addEventListener('click', () => {
    void (async () => {
      const bundle = await exportBundle();
      const text = JSON.stringify(bundle, null, 2);
      jsonArea.value = text;
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `hyperlab-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      ioStatus.textContent = 'Файл отдан браузеру.';
      ioStatus.className = 'prompt verdict-ok';
    })();
  });

  const importAreaBtn = el('button', { class: 'btn primary', type: 'button' }, ['Импорт из поля']);
  importAreaBtn.addEventListener('click', () => {
    void doImport(jsonArea.value);
  });

  const fileInput = el('input', { type: 'file', accept: 'application/json,.json' }) as HTMLInputElement;
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      jsonArea.value = text;
      return doImport(text);
    });
    fileInput.value = '';
  });

  const importFileBtn = el('button', { class: 'btn', type: 'button' }, ['Импорт из файла']);
  importFileBtn.addEventListener('click', () => fileInput.click());

  async function doImport(text: string): Promise<void> {
    try {
      const bundle = parseBundle(text);
      const res = await importBundle(bundle);
      ioStatus.textContent = `Импортировано: сессий ${res.sessions}, замеров ${res.measurements}, узлов ${res.openingNodes}. Настройки применены.`;
      ioStatus.className = 'prompt verdict-ok';
      await render();
    } catch (e) {
      ioStatus.textContent = `Импорт не прошёл: ${(e as Error).message}`;
      ioStatus.className = 'prompt verdict-bad';
    }
  }

  const clearBtn = el('button', { class: 'btn danger', type: 'button' }, ['Очистить измерения']);
  let armed = false;
  clearBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      clearBtn.textContent = 'Точно очистить? Нажми ещё раз';
      window.setTimeout(() => {
        armed = false;
        clearBtn.textContent = 'Очистить измерения';
      }, 4000);
      return;
    }
    void (async () => {
      await clearMeasurements();
      armed = false;
      clearBtn.textContent = 'Очистить измерения';
      ioStatus.textContent = 'Измерения удалены. Настройки калибровки сохранены.';
      ioStatus.className = 'prompt verdict-ok';
      await render();
    })();
  });

  root.append(
    panel('Хранение на этом устройстве', [storageHost]),
    panel('Сводка по модулям', [overviewHost]),
    panel('По режимам', [perModuleHost]),
    panel('Моторика в разрезах', [motoricsHost]),
    panel('Дебюты: самые медленные узлы', [openingsHost]),
    panel('Последние сессии', [sessionsHost]),
    panel('Экспорт и импорт', [
      el('div', { class: 'row' }, [exportBtn, downloadBtn, importAreaBtn, importFileBtn, fileInput]),
      jsonArea,
      ioStatus,
      el('div', { class: 'row' }, [clearBtn]),
      el('p', { class: 'hint' }, [
        'Очистка удаляет сессии, замеры и статистику дебютных узлов. Настройки калибровки остаются.',
      ]),
    ]),
  );

  void render();

  return () => {};
}
