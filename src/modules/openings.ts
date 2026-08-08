import type { AppContext, Unmount } from '../main';
import { el } from '../core/ui';

export function mountOpenings(root: HTMLElement, _ctx: AppContext): Unmount {
  root.append(el('h1', {}, ['openings']));
  return () => {};
}
