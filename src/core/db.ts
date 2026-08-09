import { openDB, type IDBPDatabase } from 'idb';
import { type Calibration, DEFAULT_CALIBRATION, normalizeCalibration } from './settings';

export type ModuleId = 'motorics' | 'premove' | 'reaction' | 'openings' | 'scramble';

export interface SessionRecord {
  id: string;
  module: ModuleId;
  mode: string;
  startedAt: number;
  endedAt: number | null;
  calibration: Calibration;
  summary: Record<string, number | string | null>;
}

/** Один замер. Всегда несёт снимок калибровки — требование задания. */
export interface MeasurementRecord {
  id: string;
  sessionId: string;
  module: ModuleId;
  mode: string;
  ts: number;
  calibration: Calibration;
  /** Модуль-специфичные поля замера. */
  data: Record<string, unknown>;
}

export interface ExportBundle {
  app: 'sciencechess-hyperlab';
  version: 1;
  exportedAt: number;
  calibration: Calibration;
  sessions: SessionRecord[];
  measurements: MeasurementRecord[];
  openingNodes: OpeningNodeStat[];
}

/** Накопленная статистика по узлу дебютного дерева (для «заминок»). */
export interface OpeningNodeStat {
  id: string; // repertoireId + '|' + path
  repertoireId: string;
  path: string; // SAN-ходы через пробел до узла
  expectedSan: string;
  samples: number[]; // последние задержки, мс
  updatedAt: number;
}

const DB_NAME = 'sciencechess-hyperlab';
const DB_VERSION = 1;

let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('sessions')) {
          const s = d.createObjectStore('sessions', { keyPath: 'id' });
          s.createIndex('module', 'module');
          s.createIndex('startedAt', 'startedAt');
        }
        if (!d.objectStoreNames.contains('measurements')) {
          const m = d.createObjectStore('measurements', { keyPath: 'id' });
          m.createIndex('module', 'module');
          m.createIndex('sessionId', 'sessionId');
          m.createIndex('ts', 'ts');
        }
        if (!d.objectStoreNames.contains('openingNodes')) {
          d.createObjectStore('openingNodes', { keyPath: 'id' });
        }
      },
    });
  }
  return dbp;
}

export function uid(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface StorageStatus {
  /** Браузер пообещал не вычищать данные сам. */
  persistent: boolean;
  /** Поддерживает ли браузер запрос постоянного хранения. */
  supported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
}

/**
 * Просит браузер держать данные постоянно.
 *
 * Зачем: Safari на iOS по умолчанию чистит IndexedDB сайта, если им
 * не пользовались семь дней. Постоянное хранение снимает этот таймер.
 * Установленное на Home Screen приложение под ограничение не попадает,
 * но лишний запрос не мешает.
 */
export async function requestPersistentStorage(): Promise<StorageStatus> {
  const s = navigator.storage;
  if (!s || typeof s.persist !== 'function') {
    return { persistent: false, supported: false, usageBytes: null, quotaBytes: null };
  }
  let persistent = false;
  try {
    persistent = (await s.persisted?.()) ?? false;
    if (!persistent) persistent = await s.persist();
  } catch {
    persistent = false;
  }
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const est = await s.estimate?.();
    usageBytes = est?.usage ?? null;
    quotaBytes = est?.quota ?? null;
  } catch {
    // Оценка места необязательна: без неё всё работает.
  }
  return { persistent, supported: true, usageBytes, quotaBytes };
}

export async function storageStatus(): Promise<StorageStatus> {
  const s = navigator.storage;
  if (!s || typeof s.persist !== 'function') {
    return { persistent: false, supported: false, usageBytes: null, quotaBytes: null };
  }
  let persistent = false;
  try {
    persistent = (await s.persisted?.()) ?? false;
  } catch {
    persistent = false;
  }
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const est = await s.estimate?.();
    usageBytes = est?.usage ?? null;
    quotaBytes = est?.quota ?? null;
  } catch {
    // Не критично.
  }
  return { persistent, supported: true, usageBytes, quotaBytes };
}

export async function loadCalibration(): Promise<Calibration> {
  const d = await db();
  const raw = await d.get('kv', 'calibration');
  return raw ? normalizeCalibration(raw) : { ...DEFAULT_CALIBRATION };
}

export async function saveCalibration(c: Calibration): Promise<void> {
  const d = await db();
  await d.put('kv', normalizeCalibration(c), 'calibration');
}

export async function putSession(s: SessionRecord): Promise<void> {
  const d = await db();
  await d.put('sessions', s);
}

export async function putMeasurement(m: MeasurementRecord): Promise<void> {
  const d = await db();
  await d.put('measurements', m);
}

export async function putMeasurements(ms: MeasurementRecord[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('measurements', 'readwrite');
  await Promise.all(ms.map((m) => tx.store.put(m)));
  await tx.done;
}

export async function allSessions(): Promise<SessionRecord[]> {
  const d = await db();
  return (await d.getAll('sessions')) as SessionRecord[];
}

export async function allMeasurements(): Promise<MeasurementRecord[]> {
  const d = await db();
  return (await d.getAll('measurements')) as MeasurementRecord[];
}

export async function measurementsOf(module: ModuleId): Promise<MeasurementRecord[]> {
  const d = await db();
  return (await d.getAllFromIndex('measurements', 'module', module)) as MeasurementRecord[];
}

export async function allOpeningNodes(): Promise<OpeningNodeStat[]> {
  const d = await db();
  return (await d.getAll('openingNodes')) as OpeningNodeStat[];
}

export async function getOpeningNodes(repertoireId: string): Promise<Map<string, OpeningNodeStat>> {
  const all = await allOpeningNodes();
  return new Map(all.filter((n) => n.repertoireId === repertoireId).map((n) => [n.path, n]));
}

const MAX_NODE_SAMPLES = 30;

export async function recordOpeningNode(
  repertoireId: string,
  path: string,
  expectedSan: string,
  latencyMs: number,
): Promise<void> {
  const d = await db();
  const id = `${repertoireId}|${path}`;
  const tx = d.transaction('openingNodes', 'readwrite');
  const prev = (await tx.store.get(id)) as OpeningNodeStat | undefined;
  const samples = [...(prev?.samples ?? []), latencyMs].slice(-MAX_NODE_SAMPLES);
  await tx.store.put({ id, repertoireId, path, expectedSan, samples, updatedAt: Date.now() });
  await tx.done;
}

/** Очистка измерений без сброса настроек. */
export async function clearMeasurements(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['sessions', 'measurements', 'openingNodes'], 'readwrite');
  await Promise.all([
    tx.objectStore('sessions').clear(),
    tx.objectStore('measurements').clear(),
    tx.objectStore('openingNodes').clear(),
  ]);
  await tx.done;
}

export async function exportBundle(): Promise<ExportBundle> {
  const [calibration, sessions, measurements, openingNodes] = await Promise.all([
    loadCalibration(),
    allSessions(),
    allMeasurements(),
    allOpeningNodes(),
  ]);
  return {
    app: 'sciencechess-hyperlab',
    version: 1,
    exportedAt: Date.now(),
    calibration,
    sessions,
    measurements,
    openingNodes,
  };
}

export interface ImportResult {
  sessions: number;
  measurements: number;
  openingNodes: number;
  calibrationApplied: boolean;
}

export function parseBundle(text: string): ExportBundle {
  const raw = JSON.parse(text) as Partial<ExportBundle>;
  if (!raw || typeof raw !== 'object') throw new Error('Не объект JSON');
  if (raw.app !== 'sciencechess-hyperlab') throw new Error('Чужой формат: поле app не совпадает');
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.measurements))
    throw new Error('Нет массивов sessions/measurements');
  return {
    app: 'sciencechess-hyperlab',
    version: 1,
    exportedAt: Number(raw.exportedAt ?? Date.now()),
    calibration: normalizeCalibration(raw.calibration),
    sessions: raw.sessions as SessionRecord[],
    measurements: raw.measurements as MeasurementRecord[],
    openingNodes: Array.isArray(raw.openingNodes) ? (raw.openingNodes as OpeningNodeStat[]) : [],
  };
}

/** Импорт слиянием по id. Настройки берутся из файла. */
export async function importBundle(bundle: ExportBundle): Promise<ImportResult> {
  const d = await db();
  const tx = d.transaction(['sessions', 'measurements', 'openingNodes'], 'readwrite');
  await Promise.all([
    ...bundle.sessions.map((s) => tx.objectStore('sessions').put(s)),
    ...bundle.measurements.map((m) => tx.objectStore('measurements').put(m)),
    ...bundle.openingNodes.map((n) => tx.objectStore('openingNodes').put(n)),
  ]);
  await tx.done;
  await saveCalibration(bundle.calibration);
  return {
    sessions: bundle.sessions.length,
    measurements: bundle.measurements.length,
    openingNodes: bundle.openingNodes.length,
    calibrationApplied: true,
  };
}
