import type { Color, NormalMove } from 'chessops/types';
import { PIECE_VALUE, allLegalMoves, capturedRole, type Chess } from '../core/chess';

export type BotProfile = 'fast' | 'dirty-flag' | 'human2200' | 'machinegun';

export const BOT_LABELS: Record<BotProfile, string> = {
  fast: 'Быстрый',
  'dirty-flag': 'Грязный флаг',
  human2200: 'Человек',
  machinegun: 'Пулемёт',
};

/** Кто считает ходы за соперника. */
export type OpponentKind = 'simple' | 'engine';

export const OPPONENT_LABELS: Record<OpponentKind, string> = {
  simple: 'Простой бот',
  engine: 'Stockfish',
};

/**
 * Уровни силы движка. Значения идут прямо в UCI_Elo, поэтому
 * «2200» означает ровно то, что написано, а не название профиля.
 */
export const ENGINE_LEVELS = [1400, 1800, 2200, 2600] as const;
export type EngineLevel = (typeof ENGINE_LEVELS)[number] | 'max';

export function eloOfLevel(level: EngineLevel): number | null {
  return level === 'max' ? null : level;
}

export function levelLabel(level: EngineLevel): string {
  return level === 'max' ? 'Максимум' : `Эло ${level}`;
}

export interface BotConfig {
  /** Границы задержки хода, мс. */
  minDelayMs: number;
  maxDelayMs: number;
  /** Вес взятия (за единицу стоимости жертвы). */
  captureWeight: number;
  /** Вес шаха. */
  checkWeight: number;
  /** Вес сокращения числа удобных ответов у соперника. */
  restrictWeight: number;
  /** Вероятность зевка: вместо лучшего хода берётся случайный. */
  blunderChance: number;
}

export const BOT_CONFIGS: Record<BotProfile, BotConfig> = {
  fast: {
    minDelayMs: 220,
    maxDelayMs: 420,
    captureWeight: 1.0,
    checkWeight: 1.5,
    restrictWeight: 0.08,
    blunderChance: 0.12,
  },
  'dirty-flag': {
    // Смысл профиля: ходить максимально быстро и тянуть игру до флага.
    minDelayMs: 90,
    maxDelayMs: 190,
    captureWeight: 0.4,
    checkWeight: 0.4,
    restrictWeight: 0.02,
    blunderChance: 0.3,
  },
  human2200: {
    minDelayMs: 420,
    maxDelayMs: 900,
    captureWeight: 1.4,
    checkWeight: 1.0,
    restrictWeight: 0.16,
    blunderChance: 0.04,
  },
  machinegun: {
    minDelayMs: 70,
    maxDelayMs: 150,
    captureWeight: 0.7,
    checkWeight: 0.8,
    restrictWeight: 0.0,
    blunderChance: 0.45,
  },
};

export function botDelay(profile: BotProfile, rnd: () => number): number {
  const c = BOT_CONFIGS[profile];
  return c.minDelayMs + rnd() * (c.maxDelayMs - c.minDelayMs);
}

/**
 * Оценка хода для бота. Считается только по одному полуходу вперёд:
 * материал взятия, шах и то, насколько сузился выбор у соперника.
 */
export function scoreMove(pos: Chess, move: NormalMove, config: BotConfig): number {
  let score = 0;

  const victim = capturedRole(pos, move);
  if (victim) score += config.captureWeight * PIECE_VALUE[victim];

  const after = pos.clone();
  after.play(move);

  if (after.isCheckmate()) return 1000;
  if (after.isCheck()) score += config.checkWeight;

  if (config.restrictWeight > 0) {
    const replies = allLegalMoves(after).length;
    score -= config.restrictWeight * replies;
  }

  // Не подставляться совсем уж бесплатно: если после хода фигуру бьют
  // и она дороже, чем взятое, это минус.
  const moved = pos.board.get(move.from);
  if (moved && moved.role !== 'king') {
    const attackers = after.kingAttackers(move.to, after.turn, after.board.occupied);
    if (attackers.nonEmpty()) {
      const loss = PIECE_VALUE[moved.role] - (victim ? PIECE_VALUE[victim] : 0);
      if (loss > 0) score -= loss * 0.8;
    }
  }

  return score;
}

/**
 * Выбор хода ботом. С вероятностью blunderChance берётся случайный ход,
 * иначе — лучший по scoreMove (ничьи разрешаются случайно).
 */
export function chooseMove(pos: Chess, profile: BotProfile, rnd: () => number): NormalMove | null {
  const moves = allLegalMoves(pos);
  if (!moves.length) return null;
  const config = BOT_CONFIGS[profile];

  if (rnd() < config.blunderChance) {
    return moves[Math.floor(rnd() * moves.length)];
  }

  let best: NormalMove[] = [];
  let bestScore = -Infinity;
  for (const move of moves) {
    const s = scoreMove(pos, move, config);
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = [move];
    } else if (Math.abs(s - bestScore) <= 1e-9) {
      best.push(move);
    }
  }
  return best[Math.floor(rnd() * best.length)];
}

export type Outcome =
  | 'mate-user'
  | 'mate-bot'
  | 'draw'
  | 'flag-user'
  | 'flag-bot'
  | 'aborted';

export const OUTCOME_LABELS: Record<Outcome, string> = {
  'mate-user': 'Мат поставил ты',
  'mate-bot': 'Мат поставил бот',
  draw: 'Ничья',
  'flag-user': 'Твоя просрочка',
  'flag-bot': 'Просрочка соперника',
  aborted: 'Прервано',
};

/**
 * Часы обеих сторон. Время списывается только с той стороны, которая
 * реально думает: переключение происходит в момент хода.
 */
export class Clocks {
  private remaining: Record<Color, number>;
  private active: Color | null = null;
  private lastTick = 0;

  constructor(
    readonly initialMs: number,
    private now: () => number = () => performance.now(),
  ) {
    this.remaining = { white: initialMs, black: initialMs };
  }

  start(color: Color): void {
    this.active = color;
    this.lastTick = this.now();
  }

  /** Списать прошедшее время с активной стороны. */
  tick(): void {
    if (this.active === null) return;
    const t = this.now();
    const delta = t - this.lastTick;
    this.lastTick = t;
    this.remaining[this.active] = Math.max(0, this.remaining[this.active] - delta);
  }

  /** Ход сделан: добираем время думавшей стороны и передаём часы. */
  switchTo(color: Color): void {
    this.tick();
    this.active = color;
    this.lastTick = this.now();
  }

  stop(): void {
    this.tick();
    this.active = null;
  }

  get(color: Color): number {
    return this.remaining[color];
  }

  activeColor(): Color | null {
    return this.active;
  }

  /** Сторона, у которой кончилось время, либо null. */
  flagged(): Color | null {
    if (this.remaining.white <= 0) return 'white';
    if (this.remaining.black <= 0) return 'black';
    return null;
  }

  /** Сколько времени потрачено на последний ход стороной. */
  spent(color: Color, before: number): number {
    return before - this.remaining[color];
  }
}

export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  const seconds = clamped / 1000;
  if (seconds >= 10) return seconds.toFixed(1);
  return seconds.toFixed(2);
}
