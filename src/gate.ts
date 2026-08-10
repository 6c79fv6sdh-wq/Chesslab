import { el } from './core/ui';
import { CONTACT_TELEGRAM_URL, checkCode, grantAccess, hasAccess } from './core/access';

/**
 * Экран доступа поверх приложения. Интерфейс за карточкой отрисован
 * по-настоящему — он и есть фон, — но полностью выключен: #app получает
 * класс gate-locked (лёгкий блюр из styles.css), pointer-events: none и
 * inert, поэтому ни мышью, ни пальцем, ни клавиатурой до него не
 * добраться, а фокус остаётся в поле кода. Ничего не запускается само:
 * все упражнения стартуют только по кнопке «Старт», нажать которую
 * нельзя. См. main.ts.
 */
export interface GateHandle {
  /** Вернуть фокус в поле кода (см. вызов в main.ts после boot). */
  focus(): void;
}

export function mountGate(): GateHandle {
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
    el('div', { class: 'gate-title' }, ['ScienceChess ', el('span', { class: 'gate-title-accent' }, ['Lab'])]),
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
      return;
    }
    showError('Код не подошёл. Проверьте и попробуйте ещё раз.');
    input.select();
  });

  input.addEventListener('input', clearError);

  lockBackground();
  document.body.append(overlay);

  const focusInput = (): void => {
    // Только если карточка ещё на экране и пользователь сам не ушёл в неё
    // мышью: перехватывать фокус у того, кто уже печатает, незачем.
    if (!overlay.isConnected) return;
    if (overlay.contains(document.activeElement)) return;
    input.focus({ preventScroll: true });
  };

  focusInput();
  return { focus: focusInput };
}

export { hasAccess };
