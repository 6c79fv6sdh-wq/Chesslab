import { describe, it, expect } from 'vitest';
import { fmtPct, fmtSec, plural } from '../src/core/stats';

/**
 * Крупные показатели Speed Lab читают с одного взгляда, поэтому формат
 * важен не меньше самих чисел: секунды вместо миллисекунд и запятая как
 * разделитель — интерфейс русский.
 */
describe('fmtSec: секунды для крупных показателей', () => {
  it('по умолчанию два знака: 1113 мс → 1,11 с', () => {
    expect(fmtSec(1113)).toBe('1,11 с');
  });

  it('один знак для длительности сессии: 34 800 мс → 34,8 с', () => {
    expect(fmtSec(34800, 1)).toBe('34,8 с');
  });

  it('округляет, а не обрезает', () => {
    expect(fmtSec(1116)).toBe('1,12 с');
  });

  it('нет значения — прочерк, а не «NaN с»', () => {
    expect(fmtSec(null)).toBe('—');
    expect(fmtSec(undefined)).toBe('—');
    expect(fmtSec(Number.NaN)).toBe('—');
  });
});

describe('fmtPct: процент с запятой', () => {
  it('0.933 → 93,3%', () => {
    expect(fmtPct(0.933)).toBe('93,3%');
  });

  it('нет значения — прочерк', () => {
    expect(fmtPct(null)).toBe('—');
  });
});

describe('plural: склонение при числе', () => {
  const forms: [string, string, string] = ['промах', 'промаха', 'промахов'];

  it('обычные окончания', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => plural(n, forms))).toEqual([
      'промах',
      'промаха',
      'промаха',
      'промаха',
      'промахов',
      'промахов',
    ]);
  });

  it('подростковые числа — всегда родительный: 11..14 промахов', () => {
    expect([11, 12, 13, 14].map((n) => plural(n, forms))).toEqual([
      'промахов',
      'промахов',
      'промахов',
      'промахов',
    ]);
  });

  it('за сотней окончания повторяются: 21 промах, 102 промаха', () => {
    expect(plural(21, forms)).toBe('промах');
    expect(plural(102, forms)).toBe('промаха');
    expect(plural(111, forms)).toBe('промахов');
  });

  it('ноль — родительный: 0 промахов', () => {
    expect(plural(0, forms)).toBe('промахов');
  });
});
