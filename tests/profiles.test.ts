import { describe, it, expect } from 'vitest';
import { nameKeyOf, validateName, NAME_MAX } from '../src/core/profiles';

/**
 * Профили без регистрации: вход только набором своего имени. Значит
 * ключ имени обязан прощать ровно те опечатки, которые ученик делает
 * на планшете, и не прощать всё остальное — иначе двое разных детей
 * попадут в один профиль.
 */

describe('nameKeyOf: по какому ключу человек находит свой профиль', () => {
  it('регистр и лишние пробелы не мешают войти', () => {
    expect(nameKeyOf('Ваня')).toBe(nameKeyOf('ваня'));
    expect(nameKeyOf('  Ваня  ')).toBe(nameKeyOf('Ваня'));
    expect(nameKeyOf('Петя   Иванов')).toBe(nameKeyOf('Петя Иванов'));
  });

  it('ё и е — один человек: на планшете ё набирают через раз', () => {
    expect(nameKeyOf('Алёна')).toBe(nameKeyOf('Алена'));
    expect(nameKeyOf('Пётр')).toBe(nameKeyOf('Петр'));
  });

  it('разные имена остаются разными', () => {
    expect(nameKeyOf('Ваня')).not.toBe(nameKeyOf('Ваня2'));
    expect(nameKeyOf('Аня')).not.toBe(nameKeyOf('Аля'));
  });
});

describe('validateName', () => {
  it('обрезает пробелы и отдаёт имя, годное для показа', () => {
    const r = validateName('  Ваня  ');
    expect(r.ok).toBe(true);
    expect(r.clean).toBe('Ваня');
  });

  it('слишком короткое имя не проходит', () => {
    expect(validateName('я').ok).toBe(false);
    expect(validateName('  ').ok).toBe(false);
  });

  it('слишком длинное имя не проходит', () => {
    expect(validateName('я'.repeat(NAME_MAX + 1)).ok).toBe(false);
    expect(validateName('я'.repeat(NAME_MAX)).ok).toBe(true);
  });

  it('управляющие символы из буфера обмена отсекаются', () => {
    expect(validateName('Ва\u0007ня').ok).toBe(false);
    expect(validateName('Ваня\u0000').ok).toBe(false);
  });

  it('обычные имена с пробелом и дефисом проходят', () => {
    expect(validateName('Анна-Мария').ok).toBe(true);
    expect(validateName('Петя Иванов').ok).toBe(true);
    expect(validateName('kolya_2013').ok).toBe(true);
  });
});
