import type { AppContext, Unmount } from '../main';
import { el } from '../core/ui';

export function mountReaction(root: HTMLElement, _ctx: AppContext): Unmount {
  root.append(el('h1', {}, ['reaction']));
  return () => {};
}
