/**
 * Контроли времени для партий с ботом.
 *
 * Раньше выбор был только между 15, 10 и 5 СЕКУНДАМИ на всю партию: режим
 * назывался «Цейтнот» и тренировал ровно одно — скорость руки. Играть
 * шахматы в нём нельзя, доиграть до эндшпиля — тем более. Теперь есть
 * нормальная линейка от пули до классики и вариант «Без часов»: партию с
 * ботом надо уметь просто доиграть, не глядя на флаг.
 */

import type { TimeControlSpec } from './games';

export interface TimeControl extends TimeControlSpec {
  /** Короткая пометка для группировки: пуля/блиц/рапид. */
  family: 'ультра' | 'пуля' | 'блиц' | 'рапид' | 'без часов';
}

const min = (m: number): number => m * 60_000;
const sec = (s: number): number => s * 1000;

/**
 * Порядок — как в списке кнопок. Хардкорные секундные контроли оставлены
 * первыми: на них построена вся уже накопленная история «Цейтнота», и
 * убрать их — значит порвать сравнение с прошлыми замерами.
 */
export const TIME_CONTROLS: TimeControl[] = [
  { id: '15s', initialMs: sec(15), incrementMs: 0, label: '15 сек', family: 'ультра' },
  { id: '30s', initialMs: sec(30), incrementMs: 0, label: '30 сек', family: 'ультра' },
  { id: '1+0', initialMs: min(1), incrementMs: 0, label: '1+0', family: 'пуля' },
  { id: '2+1', initialMs: min(2), incrementMs: sec(1), label: '2+1', family: 'пуля' },
  { id: '3+0', initialMs: min(3), incrementMs: 0, label: '3+0', family: 'блиц' },
  { id: '3+2', initialMs: min(3), incrementMs: sec(2), label: '3+2', family: 'блиц' },
  { id: '5+0', initialMs: min(5), incrementMs: 0, label: '5+0', family: 'блиц' },
  { id: '5+3', initialMs: min(5), incrementMs: sec(3), label: '5+3', family: 'блиц' },
  { id: '10+0', initialMs: min(10), incrementMs: 0, label: '10+0', family: 'рапид' },
  { id: '15+10', initialMs: min(15), incrementMs: sec(10), label: '15+10', family: 'рапид' },
  { id: 'none', initialMs: null, incrementMs: 0, label: 'Без часов', family: 'без часов' },
];

export const DEFAULT_TIME_CONTROL = '5+3';

export function timeControl(id: string): TimeControl {
  return TIME_CONTROLS.find((t) => t.id === id) ?? TIME_CONTROLS[TIME_CONTROLS.length - 1];
}

/**
 * Часы на экране.
 *
 * До минуты показываем десятые: в пуле разница между 3,4 и 2,9 секунды
 * заметна и по ней принимают решения. От минуты и выше десятые только
 * мельтешат, поэтому переходим на м:сс.
 */
export function formatClock(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped >= 60_000) {
    const total = Math.ceil(clamped / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const seconds = clamped / 1000;
  if (seconds >= 10) return seconds.toFixed(1);
  return seconds.toFixed(2);
}
