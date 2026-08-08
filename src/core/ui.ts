export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}`.trim(), type: 'button' }, [label]);
  b.addEventListener('click', onClick);
  return b;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** Переключатель-сегменты. Возвращает элемент и сеттер активного значения. */
export function segmented<T extends string>(
  options: SegmentedOption<T>[],
  value: T,
  onChange: (v: T) => void,
): { root: HTMLElement; set: (v: T) => void } {
  const root = el('div', { class: 'seg' });
  const buttons = new Map<T, HTMLButtonElement>();
  const set = (v: T) => {
    for (const [k, b] of buttons) b.classList.toggle('active', k === v);
  };
  for (const opt of options) {
    const b = el('button', { class: 'seg-btn', type: 'button' }, [opt.label]);
    b.addEventListener('click', () => {
      set(opt.value);
      onChange(opt.value);
    });
    buttons.set(opt.value, b);
    root.append(b);
  }
  set(value);
  return { root, set };
}

export function panel(title: string, children: Array<Node | string> = []): HTMLElement {
  return el('section', { class: 'panel' }, [el('h2', {}, [title]), ...children]);
}

export function statLine(items: Array<[string, string]>): HTMLElement {
  const root = el('div', { class: 'stats' });
  for (const [k, v] of items) {
    root.append(el('div', { class: 'stat' }, [el('span', { class: 'stat-k' }, [k]), el('span', { class: 'stat-v' }, [v])]));
  }
  return root;
}

export function table(headers: string[], rows: string[][]): HTMLElement {
  const t = el('table', { class: 'tbl' });
  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) hr.append(el('th', {}, [h]));
  thead.append(hr);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    for (const c of r) tr.append(el('td', {}, [c]));
    tbody.append(tr);
  }
  if (!rows.length) {
    const tr = el('tr');
    tr.append(el('td', { colspan: String(headers.length), class: 'empty' }, ['нет данных']));
    tbody.append(tr);
  }
  t.append(thead, tbody);
  const wrap = el('div', { class: 'tbl-wrap' }, [t]);
  return wrap;
}
