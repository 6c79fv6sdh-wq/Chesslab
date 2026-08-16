/**
 * Экран «кто занимается».
 *
 * Показывается до всего остального, если активного профиля нет. Ключевое
 * свойство: чужих имён на экране нет и быть не может. Поле ввода — не
 * выбор из списка, а именно набор своего имени; совпало с сохранённым —
 * вошёл со своей историей, не совпало — предложение завести новый
 * профиль. Так на общем планшете ученик не видит, кто ещё тут занимался.
 */

import { el } from '../core/ui';
import {
  activeProfileId,
  adoptOrphanRecords,
  findProfileByName,
  getProfile,
  profileCount,
  putProfile,
  setActiveProfileId,
  uid,
} from '../core/db';
import { nameKeyOf, validateName, type Profile } from '../core/profiles';

/** Войти в существующий профиль или создать новый. Возвращает профиль. */
export async function signIn(rawName: string): Promise<Profile> {
  const check = validateName(rawName);
  if (!check.ok) throw new Error(check.error);
  const key = nameKeyOf(check.clean);

  const existing = await findProfileByName(key);
  if (existing) {
    const updated: Profile = { ...existing, lastSeenAt: Date.now() };
    await putProfile(updated);
    await setActiveProfileId(updated.id);
    return updated;
  }

  const first = (await profileCount()) === 0;
  const created: Profile = {
    id: uid(),
    name: check.clean,
    nameKey: key,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  await putProfile(created);
  await setActiveProfileId(created.id);
  // Первый профиль забирает себе всё, что было записано до появления
  // профилей: это данные того же человека, просто снятые раньше.
  if (first) await adoptOrphanRecords(created.id);
  return created;
}

/** Переименовать свой профиль. Имя должно быть свободным. */
export async function renameProfile(profile: Profile, rawName: string): Promise<Profile> {
  const check = validateName(rawName);
  if (!check.ok) throw new Error(check.error);
  const key = nameKeyOf(check.clean);
  const clash = await findProfileByName(key);
  if (clash && clash.id !== profile.id) {
    throw new Error('Это имя уже занято на этом устройстве.');
  }
  const updated: Profile = { ...profile, name: check.clean, nameKey: key };
  await putProfile(updated);
  return updated;
}

export async function currentProfile(): Promise<Profile | null> {
  const id = await activeProfileId();
  if (!id) return null;
  return getProfile(id);
}

export async function signOut(): Promise<void> {
  await setActiveProfileId(null);
}

/**
 * Нарисовать экран входа. `onReady` вызывается с профилем, когда вошли.
 */
export function mountProfileGate(root: HTMLElement, onReady: (p: Profile) => void): void {
  root.innerHTML = '';

  const input = el('input', {
    type: 'text',
    placeholder: 'Имя или никнейм',
    autocomplete: 'off',
    autocapitalize: 'words',
    spellcheck: 'false',
    maxlength: '24',
  }) as HTMLInputElement;

  const errorEl = el('p', { class: 'hint profile-error' }, ['']);
  const btn = el('button', { class: 'btn primary', type: 'submit' }, ['Продолжить']);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    errorEl.textContent = '';
    btn.disabled = true;
    try {
      const profile = await signIn(input.value);
      onReady(profile);
    } catch (err) {
      errorEl.textContent = (err as Error).message || 'Не получилось войти.';
      btn.disabled = false;
      input.focus();
    }
  };

  const form = el('form', { class: 'profile-form' }, [
    el('label', { for: 'profile-name' }, ['Как тебя зовут?']),
    input,
    el('div', { class: 'row' }, [btn]),
    errorEl,
  ]);
  input.id = 'profile-name';
  form.addEventListener('submit', (e) => void submit(e));

  root.append(
    el('section', { class: 'panel profile-gate' }, [
      el('h1', {}, ['ScienceChess Lab']),
      el('p', { class: 'setup-lead' }, [
        'Введи своё имя — под ним сохранятся тренировки и партии. ',
        'Регистрации нет, всё остаётся на этом устройстве.',
      ]),
      form,
      el('p', { class: 'hint' }, [
        'Занимался раньше — набери то же имя, и вся история будет на месте.',
      ]),
    ]),
  );

  input.focus();
}
