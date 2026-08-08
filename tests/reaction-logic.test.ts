import { describe, it, expect } from 'vitest';
import {
  findFreeCaptures,
  findSafeChecks,
  generateDeltaTask,
  generateFreeCaptureTask,
  generatePosition,
  generateSafeCheckTask,
} from '../src/modules/reaction-logic';
import {
  allLegalMoves,
  anyMoveCapturesKing,
  kingsAdjacent,
  opponentKingInCheck,
  posFromFen,
  tryPosFromFen,
} from '../src/core/chess';

/** Детерминированный генератор, чтобы падения воспроизводились. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('генератор случайных позиций, 2000 прогонов', () => {
  it('все позиции валидны и удовлетворяют ограничениям', () => {
    const rnd = lcg(987654321);
    let produced = 0;

    for (let i = 0; i < 2000; i++) {
      const gen = generatePosition(rnd);
      expect(gen, `прогон ${i}: генератор не собрал позицию`).not.toBeNull();
      produced++;

      const { fen } = gen!;

      // FEN валиден и читается обратно в ту же позицию.
      expect(tryPosFromFen(fen), `прогон ${i}: невалидный FEN ${fen}`).not.toBeNull();
      const reparsed = posFromFen(fen);

      // Король соперника не под боем.
      expect(opponentKingInCheck(reparsed), `прогон ${i}: король соперника под боем, ${fen}`).toBe(
        false,
      );
      // Сторона на своём ходу не под шахом.
      expect(reparsed.isCheck(), `прогон ${i}: сторона на ходу под шахом, ${fen}`).toBe(false);
      // Короли не рядом.
      expect(kingsAdjacent(reparsed), `прогон ${i}: короли рядом, ${fen}`).toBe(false);
      // Оба короля на месте, ровно по одному.
      expect(reparsed.board.king.intersect(reparsed.board.white).size()).toBe(1);
      expect(reparsed.board.king.intersect(reparsed.board.black).size()).toBe(1);

      // Ни одного хода со взятием короля.
      const moves = allLegalMoves(reparsed);
      expect(moves.length, `прогон ${i}: нет ходов, ${fen}`).toBeGreaterThan(0);
      expect(anyMoveCapturesKing(reparsed, moves), `прогон ${i}: ход бьёт короля, ${fen}`).toBe(
        false,
      );

      // Пешек на крайних горизонталях быть не должно.
      for (const [sq, piece] of reparsed.board) {
        if (piece.role === 'pawn') {
          const rank = sq >> 3;
          expect(rank === 0 || rank === 7, `прогон ${i}: пешка на ${sq}, ${fen}`).toBe(false);
        }
      }
    }

    expect(produced).toBe(2000);
  }, 60000);
});

describe('решения упражнений не содержат взятия короля', () => {
  it('бесплатные взятия и безопасные шахи', () => {
    const rnd = lcg(24681357);
    let freeTasks = 0;
    let checkTasks = 0;

    for (let i = 0; i < 200; i++) {
      const free = generateFreeCaptureTask(rnd);
      if (free) {
        freeTasks++;
        for (const s of free.solutions) {
          const target = free.pos.board.get(
            (s.to.charCodeAt(1) - 49) * 8 + (s.to.charCodeAt(0) - 97),
          );
          expect(target?.role, `взятие короля в решении: ${free.fen} ${s.uci}`).not.toBe('king');
        }
      }
      const safe = generateSafeCheckTask(rnd);
      if (safe) {
        checkTasks++;
        for (const s of safe.solutions) {
          const target = safe.pos.board.get(
            (s.to.charCodeAt(1) - 49) * 8 + (s.to.charCodeAt(0) - 97),
          );
          expect(target?.role, `взятие короля в решении: ${safe.fen} ${s.uci}`).not.toBe('king');
        }
      }
    }

    expect(freeTasks).toBeGreaterThan(0);
    expect(checkTasks).toBeGreaterThan(0);
  }, 60000);
});

describe('детектор бесплатного взятия', () => {
  it('находит ровно ожидаемый ход: ферзь берёт незащищённую ладью', () => {
    // Белый ферзь d1, чёрная ладья d7 без защиты. Ладья h8 не защищает d7.
    const pos = posFromFen('7k/3r4/8/8/8/8/8/3QK3 w - - 0 1');
    const found = findFreeCaptures(pos).map((s) => s.uci).sort();
    expect(found).toEqual(['d1d7']);
  });

  it('не считает бесплатным взятие защищённой фигуры', () => {
    // Ладья d7 защищена ладьёй d8: взятие уже не бесплатное.
    const pos = posFromFen('3r3k/3r4/8/8/8/8/8/3QK3 w - - 0 1');
    expect(findFreeCaptures(pos)).toEqual([]);
  });

  it('игнорирует взятие пешки: она дешевле коня', () => {
    const pos = posFromFen('7k/3p4/8/8/8/8/8/3QK3 w - - 0 1');
    expect(findFreeCaptures(pos)).toEqual([]);
  });

  it('находит взятие и коня, и слона', () => {
    // Ферзь d5 бьёт коня d8 по вертикали и слона g8 по диагонали.
    // Ни того, ни другого чёрные защитить не могут.
    const pos = posFromFen('3n2b1/8/7k/3Q4/8/8/8/K7 w - - 0 1');
    const found = findFreeCaptures(pos).map((s) => s.uci).sort();
    expect(found).toEqual(['d5d8', 'd5g8']);
  });

  it('находит несколько бесплатных взятий сразу', () => {
    // Ладья a8 и ферзь h5 не защищены; белая ладья a1 и слон d1 их берут.
    const pos = posFromFen('r6k/8/8/7q/8/8/8/R2BK3 w - - 0 1');
    const found = findFreeCaptures(pos).map((s) => s.uci).sort();
    expect(found).toEqual(['a1a8', 'd1h5']);
  });
});

describe('детектор безопасного шаха', () => {
  it('находит шах, при котором фигуру нельзя взять', () => {
    // Ладья a1 идёт на a8 с шахом, взять её нечем.
    const pos = posFromFen('7k/8/8/8/8/8/8/R3K3 w - - 0 1');
    const found = findSafeChecks(pos).map((s) => s.uci).sort();
    expect(found).toContain('a1a8');
  });

  it('шах под бой не считается безопасным', () => {
    // Ладья a1 на a8 попадёт под бой ладьи b8.
    const pos = posFromFen('1r5k/8/8/8/8/8/8/R3K3 w - - 0 1');
    const found = findSafeChecks(pos).map((s) => s.uci);
    expect(found).not.toContain('a1a8');
  });
});

describe('дельта позиции', () => {
  it('ход соперника легален, поля различаются, позиции после хода валидны', () => {
    const rnd = lcg(5150);
    for (let i = 0; i < 200; i++) {
      const task = generateDeltaTask(rnd);
      expect(task).not.toBeNull();
      const t = task!;
      expect(t.from).not.toBe(t.to);
      expect(tryPosFromFen(t.fen)).not.toBeNull();
      expect(tryPosFromFen(t.afterFen)).not.toBeNull();
      // Ходит соперник, пользователь смотрит с другой стороны.
      expect(t.pos.turn).not.toBe(t.userColor);
    }
  }, 30000);
});
