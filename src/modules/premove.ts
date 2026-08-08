import type { AppContext, Unmount } from '../main';
import { el } from '../core/ui';

export function mountPremove(root: HTMLElement, _ctx: AppContext): Unmount {
  root.append(el('h1', {}, ['premove']));
  return () => {};
}
