/**
 * «Мои партии»: список сохранённых партий, просмотр и доигрывание.
 *
 * Одна вкладка, два состояния — список и разбор одной партии. Отдельных
 * панелей и настроек здесь нет намеренно: это архив, а не тренажёр.
 */

import type { AppContext, Unmount } from '../main';
import { Board } from '../board/board';
import { el, panel } from '../core/ui';
import { deleteGame, gamesOfProfile } from '../core/db';
import type { GameRecord } from '../core/games';
import { pgnDate } from '../core/games';
import { markResumeGame } from './resume';
import {
  checkedColor,
  fenOf,
  keyOf,
  moveFromUci,
  posFromFen,
  type Chess,
} from '../core/chess';
import type { Key } from 'chessground/types';

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Короткий итог для строки списка. */
function outcomeText(g: GameRecord): string {
  if (g.status === 'live') return 'не доиграна';
  return g.resultLabel || g.result;
}

export function mountGames(root: HTMLElement, ctx: AppContext): Unmount {
  const cal = ctx.calibration;
  let board: Board | null = null;
  let disposed = false;

  const host = el('div', {});
  root.append(el('h1', {}, ['Мои партии']), host);

  /** Экран списка. */
  async function showList(): Promise<void> {
    if (disposed) return;
    board?.destroy();
    board = null;
    host.innerHTML = '';

    const games = await gamesOfProfile(ctx.profile.id);
    if (disposed) return;

    if (!games.length) {
      host.append(
        panel('Пока пусто', [
          el('p', { class: 'hint' }, [
            'Сыграй партию с ботом на вкладке «Цейтнот» — она сохранится сюда сама, ',
            'даже если её не доиграть.',
          ]),
        ]),
      );
      return;
    }

    const rows = games.map((g) => {
      const open = el('button', { class: 'btn game-row', type: 'button' }, [
        el('span', { class: 'game-when' }, [fmtDate(g.startedAt)]),
        el('span', { class: 'game-bot' }, [
          g.bot.name + (g.bot.rating ? ` (${g.bot.rating})` : ''),
        ]),
        el('span', { class: 'game-tc' }, [g.timeControl.label]),
        el('span', { class: 'game-moves' }, [`${Math.ceil(g.moves.length / 2)} ход.`]),
        el('span', {
          class: `game-result${g.status === 'live' ? ' live' : ''}`,
        }, [outcomeText(g)]),
      ]);
      open.addEventListener('click', () => void showGame(g));
      return open;
    });

    host.append(panel('Партии', [el('div', { class: 'game-list' }, rows)]));
  }

  /** Экран одной партии: доска, ходы, навигация. */
  async function showGame(g: GameRecord): Promise<void> {
    if (disposed) return;
    host.innerHTML = '';

    // Восстанавливаем позиции по ходам: храним UCI, а показывать надо
    // и позицию, и подсветку последнего хода на каждом полуходе.
    const positions: string[] = [g.initialFen];
    const lastMoves: (Key[] | undefined)[] = [undefined];
    let pos: Chess = posFromFen(g.initialFen);
    for (const m of g.moves) {
      try {
        const mv = moveFromUci(m.uci);
        if (!pos.isLegal(mv)) break;
        pos.play(mv);
        positions.push(fenOf(pos));
        lastMoves.push([keyOf(mv.from), keyOf(mv.to)]);
      } catch {
        break;
      }
    }

    let ply = positions.length - 1;

    const boardHost = el('div', { class: 'board-host' });
    board = new Board(boardHost, {
      orientation: g.userColor,
      size: cal.boardSize,
      coordinates: cal.coordinates,
      inputMode: 'select',
    });

    const movesEl = el('div', { class: 'game-moves-list' });
    const counterEl = el('span', { class: 'hint' }, ['']);

    const draw = (): void => {
      const fen = positions[ply];
      const p = posFromFen(fen);
      board?.setPosition({
        fen,
        orientation: g.userColor,
        turnColor: p.turn,
        movableColor: undefined,
        viewOnly: true,
        lastMove: lastMoves[ply],
        check: checkedColor(p),
      });
      counterEl.textContent = `Ход ${ply} из ${positions.length - 1}`;
      for (const [i, node] of [...movesEl.children].entries()) {
        node.classList.toggle('current', i + 1 === ply);
      }
    };

    g.moves.slice(0, positions.length - 1).forEach((m, i) => {
      const num = i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : '';
      const b = el('button', { class: 'move-chip', type: 'button' }, [`${num}${m.san}`]);
      b.addEventListener('click', () => {
        ply = i + 1;
        draw();
      });
      movesEl.append(b);
    });

    const nav = (label: string, to: () => number) => {
      const b = el('button', { class: 'btn', type: 'button' }, [label]);
      b.addEventListener('click', () => {
        ply = Math.max(0, Math.min(positions.length - 1, to()));
        draw();
      });
      return b;
    };

    const backBtn = el('button', { class: 'btn', type: 'button' }, ['← К списку']);
    backBtn.addEventListener('click', () => void showList());

    const actions: HTMLElement[] = [backBtn];

    if (g.status === 'live') {
      const resume = el('button', { class: 'btn primary', type: 'button' }, ['Продолжить партию']);
      resume.addEventListener('click', () => {
        markResumeGame(g.id);
        location.hash = '#scramble';
      });
      actions.push(resume);
    }

    const del = el('button', { class: 'btn danger', type: 'button' }, ['Удалить']);
    del.addEventListener('click', () => {
      if (!confirm('Удалить эту партию?')) return;
      void deleteGame(g.id).then(() => showList());
    });
    actions.push(del);

    const pgnBox = el('textarea', { class: 'pgn-box', readonly: 'readonly', rows: '6' });
    (pgnBox as HTMLTextAreaElement).value = g.pgn;

    host.append(
      panel(`${g.bot.name} · ${g.timeControl.label} · ${pgnDate(g.startedAt)}`, [
        el('div', { class: 'board-area' }, [
          boardHost,
          el('div', { class: 'side' }, [
            el('div', { class: 'prompt' }, [outcomeText(g)]),
            counterEl,
            el('div', { class: 'row' }, [
              nav('⏮', () => 0),
              nav('‹', () => ply - 1),
              nav('›', () => ply + 1),
              nav('⏭', () => positions.length - 1),
            ]),
            movesEl,
            el('div', { class: 'row' }, actions),
          ]),
        ]),
        el('details', { class: 'pgn-details' }, [el('summary', {}, ['PGN']), pgnBox]),
      ]),
    );

    draw();
  }

  void showList();

  return () => {
    disposed = true;
    board?.destroy();
  };
}
