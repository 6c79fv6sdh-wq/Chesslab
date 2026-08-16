import { openDB, type IDBPDatabase } from 'idb';
import { type Calibration, DEFAULT_CALIBRATION, normalizeCalibration } from './settings';
import type { Profile } from './profiles';
import type { GameRecord } from './games';

export type ModuleId = 'motorics' | 'premove' | 'reaction' | 'openings' | 'scramble';

export interface SessionRecord {
  id: string;
  module: ModuleId;
  mode: string;
  startedAt: number;
  endedAt: number | null;
  calibration: Calibration;
  summary: Record<string, number | string | null>;
  /** Чей результат. Пусто — запись из версии до профилей. */
  profileId?: string;
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
  /** Чей замер. Пусто — запись из версии до профилей. */
  profileId?: string;
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
  id: string; // profileId + '|' + repertoireId + '|' + path
  profileId?: string;
  repertoireId: string;
  path: string; // SAN-ходы через пробел до узла
  expectedSan: string;
  samples: number[]; // последние задержки, мс
  updatedAt: number;
}

const DB_NAME = 'sciencechess-hyperlab';
/**
 * 2: профили (`profiles`) и сохранённые партии (`games`).
 *
 * Замеры, снятые до профилей, не выбрасываем и не раздаём никому силой:
 * они остаются без `profileId`, а «усыновляет» их первый созданный на
 * устройстве профиль (см. adoptOrphanRecords). Так человек, который уже
 * тренировался до обновления, заведя себе профиль, видит свою историю
 * на месте, а второй ученик того же планшета — не видит чужую.
 */
const DB_VERSION = 2;

let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d, oldVersion, _newVersion, tx) {
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

        if (oldVersion < 2) {
          if (!d.objectStoreNames.contains('profiles')) {
            const p = d.createObjectStore('profiles', { keyPath: 'id' });
            // Вход только по набранному имени, поэтому ключ поиска —
            // нормализованное имя, и оно обязано быть уникальным.
            p.createIndex('nameKey', 'nameKey', { unique: true });
          }
          if (!d.objectStoreNames.contains('games')) {
            const g = d.createObjectStore('games', { keyPath: 'id' });
            g.createIndex('profileId', 'profileId');
            g.createIndex('updatedAt', 'updatedAt');
          }
          // Индексы по владельцу для уже существующих хранилищ: без них
          // выборка «мои замеры» на большой истории шла бы перебором.
          const sessions = tx.objectStore('sessions');
          if (!sessions.indexNames.contains('profileId')) {
            sessions.createIndex('profileId', 'profileId');
          }
          const measurements = tx.objectStore('measurements');
          if (!measurements.indexNames.contains('profileId')) {
            measurements.createIndex('profileId', 'profileId');
          }
        }
      },
      blocked() {
        console.warn('Обновление базы ждёт закрытия других вкладок Lab.');
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

/**
 * Калибровку на этом устройстве уже сохраняли? Отличить «человек выбрал
 * значения по умолчанию» от «человек здесь впервые» по самим значениям
 * нельзя — отсюда отдельная проверка: по ней решается, показывать ли
 * первоначальную настройку.
 */
export async function hasSavedCalibration(): Promise<boolean> {
  const d = await db();
  return (await d.get('kv', 'calibration')) !== undefined;
}

export async function saveCalibration(c: Calibration): Promise<void> {
  const d = await db();
  await d.put('kv', normalizeCalibration(c), 'calibration');
}

/* ---------------------------------------------------------------- профили */

const ACTIVE_PROFILE_KEY = 'activeProfileId';

/**
 * Профиль по имени. Единственный способ «найти» профиль снаружи: список
 * профилей наружу не отдаётся принципиально — см. core/profiles.ts.
 */
export async function findProfileByName(nameKey: string): Promise<Profile | null> {
  const d = await db();
  const found = (await d.getFromIndex('profiles', 'nameKey', nameKey)) as Profile | undefined;
  return found ?? null;
}

export async function getProfile(id: string): Promise<Profile | null> {
  const d = await db();
  return ((await d.get('profiles', id)) as Profile | undefined) ?? null;
}

/** Сколько профилей заведено. Нужно только чтобы понять «первый ли это». */
export async function profileCount(): Promise<number> {
  const d = await db();
  return d.count('profiles');
}

export async function putProfile(p: Profile): Promise<void> {
  const d = await db();
  await d.put('profiles', p);
}

export async function activeProfileId(): Promise<string | null> {
  const d = await db();
  return ((await d.get('kv', ACTIVE_PROFILE_KEY)) as string | undefined) ?? null;
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  const d = await db();
  if (id === null) await d.delete('kv', ACTIVE_PROFILE_KEY);
  else await d.put('kv', id, ACTIVE_PROFILE_KEY);
}

/**
 * Отдать записи без владельца указанному профилю.
 *
 * Вызывается ровно один раз — при создании ПЕРВОГО профиля на устройстве.
 * До появления профилей все замеры лежали общей кучей; логично считать,
 * что их сделал тот, кто первым завёл себе имя после обновления.
 * Возвращает, сколько записей усыновлено, — это видно в настройках.
 */
export async function adoptOrphanRecords(profileId: string): Promise<number> {
  const d = await db();
  let adopted = 0;
  const tx = d.transaction(['sessions', 'measurements', 'games'], 'readwrite');
  for (const store of ['sessions', 'measurements', 'games'] as const) {
    let cursor = await tx.objectStore(store).openCursor();
    while (cursor) {
      const row = cursor.value as { profileId?: string };
      if (!row.profileId) {
        await cursor.update({ ...row, profileId });
        adopted++;
      }
      cursor = await cursor.continue();
    }
  }
  await tx.done;
  return adopted;
}

/* ---------------------------------------------------------------- партии */

export async function putGame(g: GameRecord): Promise<void> {
  const d = await db();
  await d.put('games', g);
}

export async function getGame(id: string): Promise<GameRecord | null> {
  const d = await db();
  return ((await d.get('games', id)) as GameRecord | undefined) ?? null;
}

export async function deleteGame(id: string): Promise<void> {
  const d = await db();
  await d.delete('games', id);
}

/** Партии одного профиля, свежие сверху. */
export async function gamesOfProfile(profileId: string): Promise<GameRecord[]> {
  const d = await db();
  const rows = (await d.getAllFromIndex('games', 'profileId', profileId)) as GameRecord[];
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
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

/**
 * Все выборки истории идут через активный профиль.
 *
 * Раньше эти функции отдавали содержимое хранилища целиком. Теперь на
 * одном планшете занимаются несколько человек, и «Прогресс» обязан
 * показывать только свои замеры — иначе чужие результаты попадут и в
 * графики, и в дневной план. Фильтруем здесь, в одном месте, чтобы ни
 * один вызывающий модуль не мог случайно показать чужое.
 */
async function ownedBy<T extends { profileId?: string }>(rows: T[]): Promise<T[]> {
  const active = await activeProfileId();
  if (!active) return [];
  return rows.filter((r) => r.profileId === active);
}

export async function allSessions(): Promise<SessionRecord[]> {
  const d = await db();
  return ownedBy((await d.getAll('sessions')) as SessionRecord[]);
}

export async function allMeasurements(): Promise<MeasurementRecord[]> {
  const d = await db();
  return ownedBy((await d.getAll('measurements')) as MeasurementRecord[]);
}

export async function measurementsOf(module: ModuleId): Promise<MeasurementRecord[]> {
  const d = await db();
  return ownedBy((await d.getAllFromIndex('measurements', 'module', module)) as MeasurementRecord[]);
}

export async function allOpeningNodes(): Promise<OpeningNodeStat[]> {
  const d = await db();
  return ownedBy((await d.getAll('openingNodes')) as OpeningNodeStat[]);
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
  const profileId = await activeProfileId();
  if (!profileId) return;
  const d = await db();
  // Профиль в ключе: «заминки» — это личная статистика узла, у двух
  // учеников на одном планшете они разные и складывать их нельзя.
  const id = `${profileId}|${repertoireId}|${path}`;
  const tx = d.transaction('openingNodes', 'readwrite');
  const prev = (await tx.store.get(id)) as OpeningNodeStat | undefined;
  const samples = [...(prev?.samples ?? []), latencyMs].slice(-MAX_NODE_SAMPLES);
  await tx.store.put({
    id,
    profileId,
    repertoireId,
    path,
    expectedSan,
    samples,
    updatedAt: Date.now(),
  });
  await tx.done;
}

/** Очистка своих измерений без сброса настроек. Чужие профили не трогаем. */
export async function clearMeasurements(): Promise<void> {
  const active = await activeProfileId();
  if (!active) return;
  const d = await db();
  const tx = d.transaction(['sessions', 'measurements', 'openingNodes', 'games'], 'readwrite');
  for (const store of ['sessions', 'measurements', 'openingNodes', 'games'] as const) {
    let cursor = await tx.objectStore(store).openCursor();
    while (cursor) {
      if ((cursor.value as { profileId?: string }).profileId === active) await cursor.delete();
      cursor = await cursor.continue();
    }
  }
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
