import { describe, it, expect } from 'vitest';
import { DIFFICULTIES, type Difficulty } from '../src/modules/premove';

/**
 * «Профи» — это тот самый темп, что был до появления переключателя
 * сложности. Его значения зафиксированы тестом: поменяв их, мы молча
 * оборвём сравнимость со всеми ранее записанными сессиями премувов.
 */
describe('Премувы: режимы сложности', () => {
  it('«Профи» — прежние 1,2–2,2 с на ход', () => {
    expect(DIFFICULTIES.pro.thinkMinMs).toBe(1200);
    expect(DIFFICULTIES.pro.thinkMinMs + DIFFICULTIES.pro.thinkJitterMs).toBe(2200);
  });

  it('«Любитель» даёт около 5 секунд на решение', () => {
    const { thinkMinMs, thinkJitterMs } = DIFFICULTIES.amateur;
    const mid = thinkMinMs + thinkJitterMs / 2;
    expect(mid).toBe(5000);
  });

  it('«Extreme» строго быстрее «Профи», «Любитель» — строго медленнее', () => {
    expect(DIFFICULTIES.extreme.thinkMinMs).toBeLessThan(DIFFICULTIES.pro.thinkMinMs);
    expect(DIFFICULTIES.amateur.thinkMinMs).toBeGreaterThan(DIFFICULTIES.pro.thinkMinMs);
    // Верхние границы тоже не должны пересекаться, иначе «сложнее» и
    // «легче» перестают отличаться на глаз от попытки к попытке.
    const top = (d: Difficulty) => DIFFICULTIES[d].thinkMinMs + DIFFICULTIES[d].thinkJitterMs;
    expect(top('extreme')).toBeLessThan(DIFFICULTIES.pro.thinkMinMs);
    expect(DIFFICULTIES.amateur.thinkMinMs).toBeGreaterThan(top('pro'));
  });

  it('у каждого режима есть название и пояснение', () => {
    for (const d of Object.keys(DIFFICULTIES) as Difficulty[]) {
      expect(DIFFICULTIES[d].label.length).toBeGreaterThan(0);
      expect(DIFFICULTIES[d].hint.length).toBeGreaterThan(0);
    }
  });
});
