/**
 * Сохранение партий с ботами.
 *
 * Пишем не «итог партии в конце», а состояние после КАЖДОГО хода. Партию
 * на планшете бросают на середине постоянно: закрыли вкладку, позвонили,
 * сел аккумулятор. Если писать только по завершении, всё это пропадает,
 * а именно недоигранные партии интереснее всего доигрывать потом.
 *
 * Поэтому у записи есть состояние (`status`): `live` — можно продолжить
 * с того же места, `finished` — только пересмотреть.
 */

import { INITIAL_FEN } from './chess';
import { getGame, putGame, uid } from './db';
import type { Color } from './chess';

/** Один сделанный ход: и UCI (для восстановления), и SAN (для чтения). */
export interface GameMove {
  uci: string;
  san: string;
  /** Сколько думали над ходом, мс. */
  spentMs: number;
  /** Остаток на часах после хода, мс. null — партия без часов. */
  clockLeftMs: number | null;
}

export type GameStatus = 'live' | 'finished';

/** Как закончилась партия. Пусто, пока идёт. */
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export interface TimeControlSpec {
  /** Идентификатор из TIME_CONTROLS. */
  id: string;
  /** Начальное время каждой стороне, мс. null — без часов. */
  initialMs: number | null;
  /** Добавка за ход, мс. */
  incrementMs: number;
  /** «5+3», «Без часов» — как показываем в списке партий. */
  label: string;
}

export interface GameBotSpec {
  /** Идентификатор бота (см. bots.ts). */
  id: string;
  /**
   * Имя, которое видел человек в момент партии: «Наполеон».
   *
   * Именно снимок, а не ссылка в BOTS: боты со временем
   * переименовывались, и старая партия должна остаться сыгранной против
   * того, кто в ней и был, — иначе история задним числом переписывается.
   */
  name: string;
  /** Заявленный рейтинг бота, если он есть. */
  rating: number | null;
  /** Чем считался ход: maia / stockfish / простой бот. */
  kind: string;
}

export interface GameRecord {
  id: string;
  profileId: string;
  /** Стартовая позиция. Всегда обычная — Chess960 тут нет. */
  initialFen: string;
  /** Позиция сейчас: по ней доигрывают и её же показывают в списке. */
  fen: string;
  moves: GameMove[];
  pgn: string;
  status: GameStatus;
  result: GameResult;
  /** Человекочитаемый итог: «Мат поставил ты». */
  resultLabel: string;
  userColor: Color;
  bot: GameBotSpec;
  timeControl: TimeControlSpec;
  /** Остатки на часах, чтобы доиграть с теми же цифрами. */
  clockLeftMs: { white: number; black: number } | null;
  startedAt: number;
  updatedAt: number;
}

export interface NewGameInput {
  profileId: string;
  userColor: Color;
  bot: GameBotSpec;
  timeControl: TimeControlSpec;
  initialFen?: string;
}

export function newGameRecord(input: NewGameInput): GameRecord {
  const now = Date.now();
  const initialFen = input.initialFen ?? INITIAL_FEN;
  const rec: GameRecord = {
    id: uid(),
    profileId: input.profileId,
    initialFen,
    fen: initialFen,
    moves: [],
    pgn: '',
    status: 'live',
    result: '*',
    resultLabel: '',
    userColor: input.userColor,
    bot: input.bot,
    timeControl: input.timeControl,
    clockLeftMs:
      input.timeControl.initialMs === null
        ? null
        : { white: input.timeControl.initialMs, black: input.timeControl.initialMs },
    startedAt: now,
    updatedAt: now,
  };
  rec.pgn = buildPgn(rec);
  return rec;
}

const PGN_ESCAPE = /["\\]/g;

function tag(name: string, value: string): string {
  return `[${name} "${value.replace(PGN_ESCAPE, (c) => `\\${c}`)}"]`;
}

/** Дата в формате PGN: 2026.08.13. */
export function pgnDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/**
 * PGN целиком, включая обязательную «семёрку» тегов.
 *
 * Пересобираем строку заново на каждый ход, а не дописываем хвост: так
 * не бывает состояния, когда теги (например Result) разошлись с ходами.
 * Партия — сотня ходов, пересборка стоит доли миллисекунды.
 */
export function buildPgn(g: GameRecord): string {
  const white = g.userColor === 'white' ? 'Ученик' : g.bot.name;
  const black = g.userColor === 'black' ? 'Ученик' : g.bot.name;

  const tags = [
    tag('Event', 'ScienceChess Lab'),
    tag('Site', 'ScienceChess Lab'),
    tag('Date', pgnDate(g.startedAt)),
    tag('Round', '-'),
    tag('White', white),
    tag('Black', black),
    tag('Result', g.result),
    tag('TimeControl', pgnTimeControl(g.timeControl)),
  ];
  if (g.bot.rating !== null) {
    tags.push(tag(g.userColor === 'white' ? 'BlackElo' : 'WhiteElo', String(g.bot.rating)));
  }
  if (g.initialFen !== INITIAL_FEN) {
    tags.push(tag('SetUp', '1'), tag('FEN', g.initialFen));
  }

  const body = movesText(g);
  return `${tags.join('\n')}\n\n${body}`.trim();
}

/** «300+3» по стандарту PGN; «-» когда часов нет. */
export function pgnTimeControl(tc: TimeControlSpec): string {
  if (tc.initialMs === null) return '-';
  return `${Math.round(tc.initialMs / 1000)}+${Math.round(tc.incrementMs / 1000)}`;
}

/**
 * Ходы с номерами. Первый ход чёрных после позиции из FEN печатается
 * как «1... e5» — иначе доигранная с середины партия читается неверно.
 */
function movesText(g: GameRecord): string {
  const startsBlack = / b /.test(g.initialFen);
  const firstNumber = Number(g.initialFen.split(' ')[5] ?? 1) || 1;
  const out: string[] = [];
  let n = firstNumber;
  g.moves.forEach((m, i) => {
    const blackToMove = startsBlack ? i % 2 === 0 : i % 2 === 1;
    if (!blackToMove) out.push(`${n}.`);
    else if (i === 0) out.push(`${n}...`);
    out.push(m.san);
    if (blackToMove) n++;
  });
  if (g.result !== '*') out.push(g.result);
  return wrap(out.join(' '), 80);
}

/** Перенос строк по 80 символов — так требует спецификация PGN. */
function wrap(text: string, width: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * Автосохранение партии.
 *
 * Пишем через микро-задержку: за один ход состояние меняется несколько
 * раз подряд (позиция, часы, итог), и без склейки в IndexedDB летели бы
 * три записи вместо одной. Задержка маленькая — партию всё равно надо
 * успеть сохранить до того, как вкладку закроют.
 *
 * `flush()` — принудительная запись без ожидания: вызывается на
 * завершении партии и на pagehide.
 */
export class GameAutosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: GameRecord | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly delayMs = 120) {}

  /** Запомнить состояние и записать его в базу в ближайшее время. */
  save(game: GameRecord): void {
    this.pending = { ...game, updatedAt: Date.now() };
    if (this.timer !== null) return;
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Записать немедленно. Возвращает промис завершения записи. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
    const game = this.pending;
    this.pending = null;
    if (!game) return this.chain;
    // Последовательная цепочка: две параллельные записи одной партии
    // могли бы лечь в базу в обратном порядке.
    this.chain = this.chain.then(() => putGame(game)).catch(() => undefined);
    return this.chain;
  }

  dispose(): void {
    void this.flush();
  }
}

/** Прочитать партию для просмотра или продолжения. */
export async function loadGame(id: string): Promise<GameRecord | null> {
  return getGame(id);
}
