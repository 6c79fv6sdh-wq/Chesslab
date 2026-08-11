import { el, panel } from './core/ui';
import { CONTACT_TELEGRAM_URL, checkCode, grantAccess, hasAccess } from './core/access';

/**
 * Публичная витрина Lab — то, что видит посетитель БЕЗ доступа. Рендерится
 * прямо в #view, вместо вкладок: boot() (монтирование вкладок, чтение
 * IndexedDB) не вызывается вовсе, пока код не введён и не подтверждён —
 * см. вызов в main.ts. Сам ввод кода живёт в нативном <dialog>, который
 * открывается по кнопке «Войти в Lab» — форма и её проверка не изменились,
 * просто раньше показывались сразу, теперь по кнопке.
 */

interface Slide {
  src: string;
  title: string;
  caption: string;
}

// Реальные скриншоты реальных режимов (public/showcase/*.webp), подписи
// сверены с их фактическим поведением — ничего не выдумано.
const SLIDES: Slide[] = [
  {
    src: './showcase/premove.webp',
    title: 'Premove',
    caption: 'Форсированное взятие, safe/unsafe и отмена — сотни реальных позиций из партий мастеров.',
  },
  {
    src: './showcase/reaction.webp',
    title: 'Реакция',
    caption: 'Мат в один ход и бесплатное взятие на скорость, с ограничением показа фигур или без.',
  },
  {
    src: './showcase/motorics.webp',
    title: 'Моторика',
    caption: 'Клик по нужной клетке: точность и скорость ввода.',
  },
  {
    src: './showcase/openings.webp',
    title: 'Дебюты',
    caption: 'Репертуар по узлам: где ход находится сразу, а где идёт заминка.',
  },
  {
    src: './showcase/scramble.webp',
    title: 'Цейтнот',
    caption: 'Ультрабуллет против бота — решения и игра на флажке.',
  },
  {
    src: './showcase/progress.webp',
    title: 'Прогресс',
    caption: 'Каждый замер сохраняется: время, точность и динамика по неделям.',
  },
];

function buildGallery(slides: Slide[]): HTMLElement {
  const viewport = el('div', {
    class: 'carousel-viewport',
    role: 'region',
    'aria-label': 'Скриншоты режимов Lab',
  });

  const slideEls = slides.map((s) =>
    el('figure', { class: 'carousel-slide' }, [
      // Без loading="lazy": все шесть скриншотов вместе весят ~55 КБ, зато
      // свайп по галерее не упирается в пустой кадр, пока грузится соседний.
      el('img', {
        src: s.src,
        alt: `Скриншот режима «${s.title}»`,
        width: '560',
        height: '257',
        decoding: 'async',
      }),
      el('figcaption', {}, [el('strong', {}, [s.title]), el('span', {}, [s.caption])]),
    ]),
  );
  for (const s of slideEls) viewport.append(s);

  const prevBtn = el('button', { class: 'carousel-arrow', type: 'button', 'aria-label': 'Предыдущий пример' }, ['‹']);
  const nextBtn = el('button', { class: 'carousel-arrow', type: 'button', 'aria-label': 'Следующий пример' }, ['›']);
  const dotsWrap = el('div', { class: 'carousel-dots' });
  const dots = slides.map((_, i) => {
    const d = el('button', { class: 'carousel-dot', type: 'button', 'aria-label': `Пример ${i + 1} из ${slides.length}` });
    d.addEventListener('click', () => scrollToIndex(i));
    dotsWrap.append(d);
    return d;
  });

  let current = 0;
  function setActive(i: number): void {
    current = i;
    dots.forEach((d, k) => d.classList.toggle('active', k === i));
    (prevBtn as HTMLButtonElement).disabled = i === 0;
    (nextBtn as HTMLButtonElement).disabled = i === slides.length - 1;
  }
  function scrollToIndex(i: number): void {
    const clamped = Math.max(0, Math.min(slides.length - 1, i));
    viewport.scrollTo({ left: clamped * viewport.clientWidth, behavior: 'smooth' });
    setActive(clamped);
  }
  setActive(0);

  prevBtn.addEventListener('click', () => scrollToIndex(current - 1));
  nextBtn.addEventListener('click', () => scrollToIndex(current + 1));

  // Догоняем свайп пальцем/трекпадом: после того как прокрутка утихла,
  // синхронизируем точки и стрелки с реально видимым слайдом.
  let scrollTimer: number | null = null;
  viewport.addEventListener(
    'scroll',
    () => {
      if (scrollTimer !== null) window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        const width = viewport.clientWidth || 1;
        const i = Math.round(viewport.scrollLeft / width);
        setActive(Math.max(0, Math.min(slides.length - 1, i)));
      }, 90);
    },
    { passive: true },
  );

  const controls = el('div', { class: 'carousel-controls' }, [prevBtn, dotsWrap, nextBtn]);
  return el('div', { class: 'carousel' }, [viewport, controls]);
}

function buildLoginDialog(onUnlock: () => void): { dialog: HTMLDialogElement; open: () => void } {
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

  const closeBtn = el('button', { class: 'gate-dialog-close', type: 'button', 'aria-label': 'Закрыть' }, ['×']);

  const dialog = el(
    'dialog',
    { class: 'gate-dialog', 'aria-label': 'Вход в Lab' },
    [closeBtn, el('div', { class: 'gate-dialog-title' }, ['Вход в Lab']), form],
  ) as HTMLDialogElement;

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
      dialog.close();
      onUnlock();
      return;
    }
    showError('Код не подошёл. Проверьте и попробуйте ещё раз.');
    input.select();
  });
  input.addEventListener('input', clearError);
  closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    input.value = '';
    clearError();
  });
  // Клик по backdrop закрывает диалог, как в лайтбоксе на основном сайте.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  document.body.append(dialog);

  function open(): void {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', ''); // старые браузеры без <dialog> — просто показываем
    input.focus({ preventScroll: true });
  }

  return { dialog, open };
}

/**
 * Демонстрационные числа для блока «Прогресс». Это витрина для родителей
 * без доступа: показываем, ЧТО именно Lab измеряет и накапливает, а не
 * чьи-то настоящие результаты. Поэтому блок прямо подписан как пример —
 * выдавать выдуманные цифры за реальные замеры нельзя.
 */
interface DemoMetric {
  label: string;
  value: string;
  note: string;
}

const DEMO_METRICS: DemoMetric[] = [
  { label: 'Время решения', value: '640 мс', note: 'медиана за неделю' },
  { label: 'Точность', value: '92%', note: 'верных решений из всех' },
  { label: 'Динамика', value: '−18%', note: 'время решения за месяц' },
];

function buildProgressBlock(): HTMLElement {
  const metrics = el(
    'div',
    { class: 'metrics' },
    DEMO_METRICS.map((m) =>
      el('div', { class: 'metric' }, [
        el('span', { class: 'metric-k' }, [m.label]),
        el('span', { class: 'metric-v' }, [m.value]),
        el('span', { class: 'metric-note' }, [m.note]),
      ]),
    ),
  );

  return el('div', {}, [
    el('p', { class: 'showcase-lead' }, [
      'Каждое задание замеряется и сохраняется на устройстве: сколько заняло ',
      'решение, что решено верно, как это меняется от недели к неделе. ',
      'Тренировка не «прошла и забылась» — она видна в цифрах.',
    ]),
    metrics,
    el('p', { class: 'hint' }, ['Числа выше — пример оформления, не чьи-то результаты.']),
  ]);
}

export function mountGate(onUnlock: () => void): void {
  const view = document.getElementById('view');
  if (!view) return;
  view.innerHTML = '';

  // Публичная страница — не рабочий экран: собственную шапку приложения
  // и пустую полосу вкладок прячем, чтобы название не дублировалось и
  // над витриной не висела чужая разделительная линия.
  const app = document.getElementById('app');
  app?.classList.add('app-public');

  const { open: openLogin } = buildLoginDialog(() => {
    app?.classList.remove('app-public');
    onUnlock();
  });

  const contactLink = el(
    'a',
    {
      class: 'btn primary',
      href: CONTACT_TELEGRAM_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    ['Обсудить занятия'],
  );

  const loginBtn = el('button', { class: 'btn', type: 'button' }, ['Уже есть код? Войти']);
  loginBtn.addEventListener('click', openLogin);

  view.append(
    el('header', { class: 'hero' }, [
      el('h1', { class: 'hero-title' }, [
        'ScienceChess ',
        el('span', { class: 'brand-accent' }, ['Lab']),
      ]),
      el('p', { class: 'hero-lead' }, [
        'Тренажеры скорости, внимания и принятия решений в шахматах',
      ]),
      el('p', { class: 'hero-modules' }, ['Моторика · Реакция · Premove · Дебюты · Цейтнот']),
    ]),
    panel('Тренировочные модули', [buildGallery(SLIDES)]),
    panel('Прогресс', [buildProgressBlock()]),
    el('section', { class: 'panel cta' }, [
      el('div', { class: 'cta-actions' }, [contactLink, loginBtn]),
      el('p', { class: 'cta-note' }, ['Lab доступен ученикам ScienceChess.']),
    ]),
  );
}

export { hasAccess };
