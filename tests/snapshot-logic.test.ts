import { describe, it, expect } from 'vitest';
import {
  ALL_SQUARES,
  SNAPSHOT_DIFFICULTY,
  SNAPSHOT_PAIR_COUNTS,
  SNAPSHOT_SCORED,
  SNAPSHOT_WARMUP,
  chooseMatchingRemoved,
  chooseRemoved,
  generateShuffledControl,
  generateSnapshotSession,
  piecesFromFen,
  quadrantOf,
  scoreAttempt,
  summarizeAttempt,
  type PlacedPiece,
} from '../src/modules/snapshot-logic';
import { SNAPSHOT_MEANINGFUL_POSITIONS } from '../src/data/snapshot-positions';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { tryPosFromFen } from '../src/core/chess';

const seeded = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

function multiset(pieces: PlacedPiece[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pieces) {
    const key = `${p.color}-${p.role}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

describe('snapshot-logic: источники позиций', () => {
  for (const pos of SNAPSHOT_MEANINGFUL_POSITIONS) {
    describe(pos.id, () => {
      it('FEN легален', () => {
        expect(tryPosFromFen(pos.fen), pos.fen).not.toBeNull();
      });

      it('FEN восстанавливается из указанной партии (pgnMoves) — не выдуман', () => {
        const replay = Chess.default();
        for (const san of pos.pgnMoves) {
          const move = parseSan(replay, san);
          expect(move, `${pos.id}: не удалось сыграть ${san}`).toBeDefined();
          replay.play(move!);
        }
        const replayedFen = makeFen(replay.toSetup());
        // Сверяем доску и очередь хода — счётчики полуходов в источнике и
        // в счётчике partial-replay не обязаны совпадать буква в букву.
        expect(replayedFen.split(' ').slice(0, 2).join(' ')).toBe(pos.fen.split(' ').slice(0, 2).join(' '));
      });

      it('источник указан полностью', () => {
        expect(pos.source.white.length).toBeGreaterThan(0);
        expect(pos.source.black.length).toBeGreaterThan(0);
        expect(pos.source.event.length).toBeGreaterThan(0);
        expect(pos.source.date.length).toBeGreaterThan(0);
        expect(pos.source.ply).toBeGreaterThan(0);
      });

      it('число фигур в FEN совпадает с заявленным pieceCount', () => {
        expect(piecesFromFen(pos.fen).length).toBe(pos.pieceCount);
      });
    });
  }

  it('распределение по сложности соответствует ТЗ: 4 лёгких + 3 средних + 1 сложная', () => {
    const byDiff = { easy: 0, medium: 0, hard: 0 };
    for (const p of SNAPSHOT_MEANINGFUL_POSITIONS) byDiff[p.difficulty]++;
    expect(byDiff).toEqual(SNAPSHOT_PAIR_COUNTS);
  });
});

describe('snapshot-logic: shuffled control', () => {
  const rnd = seeded(1);
  const meaningful = piecesFromFen(SNAPSHOT_MEANINGFUL_POSITIONS.find((p) => p.difficulty === 'hard')!.fen);

  it('control содержит точно такое же мультимножество фигур (цвет+тип+количество)', () => {
    const { pieces } = generateShuffledControl(meaningful, rnd);
    expect(multiset(pieces)).toEqual(multiset(meaningful));
    expect(pieces.length).toBe(meaningful.length);
  });

  it('пешки control не стоят на первой или восьмой горизонтали', () => {
    for (let i = 0; i < 15; i++) {
      const { pieces } = generateShuffledControl(meaningful, seeded(100 + i));
      for (const p of pieces.filter((x) => x.role === 'pawn')) {
        expect(p.square.endsWith('1'), p.square).toBe(false);
        expect(p.square.endsWith('8'), p.square).toBe(false);
      }
    }
  });

  it('короли control не соседствуют', () => {
    for (let i = 0; i < 15; i++) {
      const { pieces } = generateShuffledControl(meaningful, seeded(200 + i));
      const kings = pieces.filter((p) => p.role === 'king');
      expect(kings.length).toBe(2);
      const fileDiff = Math.abs(kings[0].square.charCodeAt(0) - kings[1].square.charCodeAt(0));
      const rankDiff = Math.abs(Number(kings[0].square[1]) - Number(kings[1].square[1]));
      expect(Math.max(fileDiff, rankDiff)).toBeGreaterThan(1);
    }
  });

  it('все клетки различны — фигуры не дублируются и не пропадают', () => {
    const { pieces } = generateShuffledControl(meaningful, seeded(3));
    const squares = new Set(pieces.map((p) => p.square));
    expect(squares.size).toBe(pieces.length);
  });

  it('плотность по четвертям доски примерно равна — ни одна четверть не пустует полностью', () => {
    const { pieces } = generateShuffledControl(meaningful, seeded(4));
    const counts = [0, 0, 0, 0];
    for (const p of pieces) counts[quadrantOf(p.square)]++;
    // 24 фигуры на 4 четверти — при разумном распределении ни одна не
    // должна остаться пустой (round-robin по построению это гарантирует).
    for (const c of counts) expect(c).toBeGreaterThan(0);
  });

  it('позиция control не совпадает случайно с реальной', () => {
    const { pieces } = generateShuffledControl(meaningful, seeded(5));
    const sigOf = (arr: PlacedPiece[]) => [...arr].sort((a, b) => a.square.localeCompare(b.square)).map((p) => p.square + p.role[0] + p.color[0]).join(',');
    expect(sigOf(pieces)).not.toBe(sigOf(meaningful));
  });
});

describe('snapshot-logic: выбор исчезающих фигур', () => {
  const meaningful = piecesFromFen(SNAPSHOT_MEANINGFUL_POSITIONS.find((p) => p.difficulty === 'hard')!.fen);

  it('короли никогда не исчезают', () => {
    for (let i = 0; i < 20; i++) {
      const removed = chooseRemoved(meaningful, 5, seeded(10 + i));
      expect(removed?.some((p) => p.role === 'king')).toBe(false);
    }
  });

  it('минимум одна пешка и минимум одна не-пешка среди исчезнувших', () => {
    for (let i = 0; i < 20; i++) {
      const removed = chooseRemoved(meaningful, 5, seeded(50 + i))!;
      expect(removed.some((p) => p.role === 'pawn')).toBe(true);
      expect(removed.some((p) => p.role !== 'pawn')).toBe(true);
    }
  });

  it('исчезнувшие фигуры лежат минимум в двух четвертях доски', () => {
    for (let i = 0; i < 20; i++) {
      const removed = chooseRemoved(meaningful, 5, seeded(70 + i))!;
      const quads = new Set(removed.map((p) => quadrantOf(p.square)));
      expect(quads.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('набор исчезнувших цветов/типов совпадает между meaningful и её control-парой', () => {
    const rnd = seeded(9);
    const removedMeaningful = chooseRemoved(meaningful, 5, rnd)!;
    const control = generateShuffledControl(meaningful, rnd);
    const removedControl = chooseMatchingRemoved(control.pieces, removedMeaningful, rnd)!;
    const sig = (arr: PlacedPiece[]) => arr.map((p) => `${p.color}-${p.role}`).sort();
    expect(sig(removedControl)).toEqual(sig(removedMeaningful));
    expect(removedControl.length).toBe(removedMeaningful.length);
  });
});

describe('snapshot-logic: сборка сессии', () => {
  it('сессия строится: разминка + зачётные, число заданий соответствует ТЗ', () => {
    const session = generateSnapshotSession(seeded(42), 42)!;
    expect(session).not.toBeNull();
    const warmup = session.tasks.filter((t) => t.warmup);
    const scored = session.tasks.filter((t) => !t.warmup);
    expect(warmup.length).toBe(SNAPSHOT_WARMUP);
    expect(scored.length).toBe(SNAPSHOT_SCORED);
    expect(scored.filter((t) => t.kind === 'meaningful').length).toBe(SNAPSHOT_SCORED / 2);
    expect(scored.filter((t) => t.kind === 'control').length).toBe(SNAPSHOT_SCORED / 2);
  });

  it('meaningful и её control-пара совпадают по сложности, времени показа, числу исчезнувших фигур, ориентации', () => {
    const session = generateSnapshotSession(seeded(7), 7)!;
    const scored = session.tasks.filter((t) => !t.warmup);
    const byPair = new Map<string, typeof scored>();
    for (const t of scored) byPair.set(t.pairId, [...(byPair.get(t.pairId) ?? []), t]);
    for (const [, pair] of byPair) {
      expect(pair.length).toBe(2);
      const [a, b] = pair;
      expect(a.difficulty).toBe(b.difficulty);
      expect(a.exposureMs).toBe(b.exposureMs);
      expect(a.removed.length).toBe(b.removed.length);
      expect(a.orientation).toBe(b.orientation);
    }
  });

  it('между meaningful и её control-парой минимум три другие попытки', () => {
    const session = generateSnapshotSession(seeded(13), 13)!;
    const scored = session.tasks.filter((t) => !t.warmup);
    const posOf = new Map(scored.map((t, i) => [t.id, i]));
    const byPair = new Map<string, string[]>();
    for (const t of scored) byPair.set(t.pairId, [...(byPair.get(t.pairId) ?? []), t.id]);
    for (const [, ids] of byPair) {
      const gap = Math.abs(posOf.get(ids[0])! - posOf.get(ids[1])!);
      expect(gap).toBeGreaterThanOrEqual(4);
    }
  });

  it('позиция (доска+исчезнувшие) не повторяется внутри сессии', () => {
    const session = generateSnapshotSession(seeded(21), 21)!;
    const sigs = session.tasks.map((t) =>
      [...t.pieces].sort((a, b) => a.square.localeCompare(b.square)).map((p) => p.square + p.role[0] + p.color[0]).join(',') +
      '|' +
      [...t.removed].sort((a, b) => a.square.localeCompare(b.square)).map((p) => p.square).join(','),
    );
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it('ориентация — сторона, чей ход в исходной позиции', () => {
    const session = generateSnapshotSession(seeded(3), 3)!;
    for (const t of session.tasks) {
      const src = t.meaningful;
      if (src) expect(t.orientation).toBe(src.sideToMove);
    }
  });

  it('одинаковый seed даёт одинаковую сессию — детерминизм для повторного анализа', () => {
    const a = generateSnapshotSession(seeded(555), 555)!;
    const b = generateSnapshotSession(seeded(555), 555)!;
    expect(a.tasks.map((t) => t.id)).toEqual(b.tasks.map((t) => t.id));
  });
});

describe('snapshot-logic: подсчёт очков', () => {
  const removed: PlacedPiece[] = [
    { square: 'e4' as never, color: 'white', role: 'pawn' },
    { square: 'g1' as never, color: 'white', role: 'knight' },
    { square: 'c8' as never, color: 'black', role: 'bishop' },
  ];

  it('правильная реконструкция даёт 100%', () => {
    const results = scoreAttempt(removed, removed.map((p) => ({ ...p })));
    const summary = summarizeAttempt(results);
    expect(summary.accuracy).toBe(1);
    expect(summary.fullyCorrect).toBe(3);
    expect(summary.missed).toBe(0);
    expect(summary.extra).toBe(0);
  });

  it('одинаковые фигуры оцениваются по цвету и типу, а не по внутреннему ID: два одинаковых коня взаимозаменяемы', () => {
    const twoKnights: PlacedPiece[] = [
      { square: 'b1' as never, color: 'white', role: 'knight' },
      { square: 'g1' as never, color: 'white', role: 'knight' },
    ];
    // Пользователь переставил их местами относительно порядка в массиве —
    // по сути оба верны, ID-совпадения тут нет и не должно требоваться.
    const placements = [
      { square: 'g1' as never, color: 'white' as const, role: 'knight' as const },
      { square: 'b1' as never, color: 'white' as const, role: 'knight' as const },
    ];
    const results = scoreAttempt(twoKnights, placements);
    expect(summarizeAttempt(results).fullyCorrect).toBe(2);
  });

  it('правильная фигура на чужой клетке — right-piece-wrong-square с ненулевой дистанцией', () => {
    const placements = [
      { square: 'e5' as never, color: 'white' as const, role: 'pawn' as const }, // должен быть e4
      { square: 'g1' as never, color: 'white' as const, role: 'knight' as const },
      { square: 'c8' as never, color: 'black' as const, role: 'bishop' as const },
    ];
    const results = scoreAttempt(removed, placements);
    const pawnResult = results.find((r) => r.role === 'pawn')!;
    expect(pawnResult.outcome).toBe('right-piece-wrong-square');
    expect(pawnResult.distance).toBeGreaterThan(0);
  });

  it('чужая фигура на правильной клетке — wrong-piece-right-square', () => {
    const placements = [
      { square: 'e4' as never, color: 'white' as const, role: 'bishop' as const }, // не тот тип
      { square: 'g1' as never, color: 'white' as const, role: 'knight' as const },
      { square: 'c8' as never, color: 'black' as const, role: 'pawn' as const }, // не тот тип
    ];
    const results = scoreAttempt(removed, placements);
    const summary = summarizeAttempt(results);
    expect(summary.typeErrors).toBeGreaterThan(0);
  });

  it('пропуск и лишнее размещение считаются отдельно (общий случай функции: панель Snapshot на практике всегда даёт placements тем же мультимножеством, что и removed, — pass 2 тогда всегда находит правильный тип, — но scoreAttempt как чистая функция обязана честно считать и вырожденный случай несовпадения)', () => {
    // Пешка и конь верны; вместо слона на a1 почему-то оказался конь —
    // ни клетка (a1≠c8), ни тип (knight≠bishop) не совпадают ни с чем
    // оставшимся, значит слон пропущен, а конь на a1 — лишний.
    const placements = [
      { square: 'e4' as never, color: 'white' as const, role: 'pawn' as const },
      { square: 'g1' as never, color: 'white' as const, role: 'knight' as const },
      { square: 'a1' as never, color: 'white' as const, role: 'knight' as const },
    ];
    const results = scoreAttempt(removed, placements);
    const summary = summarizeAttempt(results);
    expect(summary.fullyCorrect).toBe(2);
    expect(results.some((r) => r.outcome === 'missed' && r.correctSquare === 'c8')).toBe(true);
    expect(results.some((r) => r.outcome === 'extra' && r.chosenSquare === 'a1')).toBe(true);
  });

  it('перемещение фигуры и возврат в исходное состояние не создают дубликатов подсчёта', () => {
    // Симулируем: пользователь сначала поставил пешку не туда, потом
    // передумал и поставил верно — на входе в scoreAttempt должно быть
    // только ФИНАЛЬНОЕ состояние (по одному размещению на панельную
    // фигуру), поэтому результат идентичен «сразу верно».
    const finalPlacements = removed.map((p) => ({ ...p }));
    const results = scoreAttempt(removed, finalPlacements);
    expect(results.length).toBe(removed.length);
    expect(summarizeAttempt(results).fullyCorrect).toBe(3);
  });
});

describe('snapshot-logic: вспомогательные функции', () => {
  it('ALL_SQUARES содержит все 64 клетки без повторов', () => {
    expect(new Set(ALL_SQUARES).size).toBe(64);
  });

  it('пороги сложности заданы по ТЗ', () => {
    expect(SNAPSHOT_DIFFICULTY.easy).toEqual({ removeCount: 3, exposureMs: 2500 });
    expect(SNAPSHOT_DIFFICULTY.medium).toEqual({ removeCount: 4, exposureMs: 1800 });
    expect(SNAPSHOT_DIFFICULTY.hard).toEqual({ removeCount: 5, exposureMs: 1200 });
  });
});
