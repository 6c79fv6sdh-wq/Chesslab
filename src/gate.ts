import { el } from './core/ui';
import { CONTACT_TELEGRAM_URL, checkCode, grantAccess, hasAccess } from './core/access';

/**
 * Экран доступа поверх приложения. Пока код не введён, boot() приложения
 * не вызывается вовсе (см. main.ts) — вкладки не монтируются, данные из
 * IndexedDB не читаются. #app при этом виден фоном: получает класс
 * gate-locked (blur/затемнение из styles.css) и inert/pointer-events:none,
 * чтобы с ним нельзя было взаимодействовать ни мышью, ни клавиатурой.
 */
export function mountGate(onUnlock: () => void): void {
  const app = document.getElementById('app');

  const input = el('input', {
    id: 'gate-code',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    inputmode: 'text',
    class: 'gate-input',
  }) as HTMLInputElement;

  const errorEl = el('p', { class: 'gate-error' }, ['']);

  const submitBtn = el('button', { class: 'btn primary gate-submit', type: 'submit' }, ['Войти']);

  const form = el('form', { class: 'gate-form' }, [
    el('label', { for: 'gate-code', class: 'gate-label' }, ['Код доступа']),
    input,
    errorEl,
    submitBtn,
  ]);

  const contactLink = el(
    'a',
    {
      class: 'btn gate-contact',
      href: CONTACT_TELEGRAM_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    ['Получить доступ'],
  );

  const card = el('div', { class: 'gate-card' }, [
    el('div', { class: 'gate-title' }, ['Science Chess ', el('span', { class: 'gate-title-accent' }, ['Lab'])]),
    el('p', { class: 'gate-subtitle' }, ['Закрытая тренировочная лаборатория для учеников ScienceChess.']),
    form,
    el('p', { class: 'gate-no-access' }, ['Нет доступа?']),
    contactLink,
  ]);

  const overlay = el('div', { class: 'gate-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Экран доступа' }, [
    card,
  ]);

  function lockBackground(): void {
    if (!app) return;
    app.classList.add('gate-locked');
    app.setAttribute('inert', '');
    app.setAttribute('aria-hidden', 'true');
  }

  function unlockBackground(): void {
    if (!app) return;
    app.classList.remove('gate-locked');
    app.removeAttribute('inert');
    app.removeAttribute('aria-hidden');
  }

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.classList.add('visible');
  }

  function clearError(): void {
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value;
    if (!value.trim()) {
      showError('Введите код доступа.');
      return;
    }
    if (checkCode(value)) {
      grantAccess();
      overlay.remove();
      unlockBackground();
      onUnlock();
      return;
    }
    showError('Код не подошёл. Проверьте и попробуйте ещё раз.');
    input.select();
  });

  input.addEventListener('input', clearError);

  lockBackground();
  document.body.append(overlay);
  input.focus({ preventScroll: true });
}

export { hasAccess };
