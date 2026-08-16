import { describe, it, expect } from 'vitest';
import { TIME_CONTROLS, formatClock, timeControl } from '../src/core/timecontrol';
import { Clocks } from '../src/modules/scramble-logic';

/**
 * Контроли времени: раньше «Цейтнот» умел только 15/10/5 секунд на всю
 * партию. Теперь есть нормальная линейка с добавкой и вариант без часов,
 * и главное — старые секундные контроли никуда не делись: на них
 * построена вся уже снятая история.
 */

describe('линейка контролей', () => {
  it('старые секундные контроли на месте', () => {
    expect(timeControl('15s').initialMs).toBe(15000);
    expect(timeControl('15s').incrementMs).toBe(0);
  });

  it('есть нормальные контроли с добавкой', () => {
    expect(timeControl('5+3').initialMs).toBe(300000);
    expect(timeControl('5+3').incrementMs).toBe(3000);
    expect(timeControl('15+10').initialMs).toBe(900000);
    expect(timeControl('15+10').incrementMs).toBe(10000);
  });

  it('есть партия без часов', () => {
    expect(timeControl('none').initialMs).toBeNull();
  });

  it('идентификаторы уникальны', () => {
    const ids = TIME_CONTROLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('неизвестный контроль не роняет приложение', () => {
    expect(timeControl('нет такого')).toBeDefined();
  });
});

describe('формат часов', () => {
  it('под минуту — с десятыми, как раньше', () => {
    expect(formatClock(15000)).toBe('15.0');
    expect(formatClock(9500)).toBe('9.50');
    expect(formatClock(-20)).toBe('0.00');
  });

  it('от минуты — минуты и секунды, а не «312.4»', () => {
    expect(formatClock(300000)).toBe('5:00');
    expect(formatClock(65000)).toBe('1:05');
    expect(formatClock(600000)).toBe('10:00');
  });
});

describe('часы с добавкой', () => {
  /** Управляемое время: иначе тест зависит от скорости машины. */
  function fixedClocks(initial: number | null, inc: number) {
    let now = 0;
    const c = new Clocks(initial, () => now, inc);
    return { c, advance: (ms: number) => (now += ms) };
  }

  it('добавка начисляется сделавшему ход', () => {
    const { c, advance } = fixedClocks(60000, 3000);
    c.start('white');
    advance(5000);
    c.switchTo('black');
    // Потратил 5 с, получил 3 с обратно.
    expect(c.get('white')).toBe(58000);
    expect(c.get('black')).toBe(60000);
  });

  it('без добавки время только убывает', () => {
    const { c, advance } = fixedClocks(60000, 0);
    c.start('white');
    advance(5000);
    c.switchTo('black');
    expect(c.get('white')).toBe(55000);
  });

  it('упавший флаг добавкой не воскресает', () => {
    const { c, advance } = fixedClocks(1000, 3000);
    c.start('white');
    advance(1500);
    c.switchTo('black');
    expect(c.get('white')).toBe(0);
    expect(c.flagged()).toBe('white');
  });

  it('без часов время не идёт и флаг не падает', () => {
    const { c, advance } = fixedClocks(null, 0);
    c.start('white');
    advance(10 * 60 * 1000);
    c.tick();
    expect(c.untimed).toBe(true);
    expect(c.flagged()).toBeNull();
  });

  it('остатки восстанавливаются для доигрывания', () => {
    const { c } = fixedClocks(300000, 3000);
    c.restore(123456, 98765);
    expect(c.get('white')).toBe(123456);
    expect(c.get('black')).toBe(98765);
  });
});
