import type { Color } from '../core/chess';

export type SnapshotDifficulty = 'easy' | 'medium' | 'hard';
export type GamePhase = 'opening' | 'middlegame' | 'endgame';

export interface SnapshotSource {
  white: string;
  black: string;
  event: string;
  date: string;
  /** Номер полухода, на котором стоит позиция. */
  ply: number;
}

/**
 * Meaningful-позиция для Snapshot: реальная точка реальной партии — та же
 * дисциплина источников, что и в src/data/premove-positions.ts. FEN и
 * pgnMoves пересчитаны и перепроверены chessops с нуля в tests/snapshot-
 * positions.test.ts, а не переписаны из источника вручную.
 *
 * Число фигур для «Лёгкого» уровня по ТЗ — 8-10. У реальных партий, которые
 * можно перепроверить по общедоступному полному PGN, такое сокращение
 * материала встречается только в затяжных многоходовых эндшпилях — двух
 * знаменитых партий с точно выверенным полным текстом (Kasparov–Topalov
 * 1999 и Byrne–Fischer 1956) в этом сегменте оказалось 11-14 фигур, а не
 * 8-10. Расширять диапазон вниз ценой придуманной или неточно вспомненной
 * партии не стал — это ровно то самое «раздувание пула», которого просили
 * избегать. Использованы реальные фигуры-числа (11-14 «лёгкий», 16-17
 * «средний», 24 «сложный») — задача усложняется в том же порядке, что и
 * требовалось, просто с честными числами вместо надуманных.
 */
export interface MeaningfulPosition {
  id: string;
  fen: string;
  pgnMoves: string[];
  sideToMove: Color;
  pieceCount: number;
  phase: GamePhase;
  difficulty: SnapshotDifficulty;
  source: SnapshotSource;
}

export const SNAPSHOT_MEANINGFUL_POSITIONS: MeaningfulPosition[] = [
  // --- Kasparov vs Topalov, Wijk aan Zee (Hoogovens), 1999.01.20 — король
  // чёрных гоним через всю доску несколькими форсированными ходами,
  // материал стремительно сокращается: 4 позиции разного числа фигур
  // почти подряд. «Kasparov's Immortal».
  {
    id: 'sn-kasparov-topalov-1',
    fen: '7r/3r1p1p/6p1/1p6/2q5/5PP1/1Q5P/1K1k1B2 w - - 0 38',
    pgnMoves: kasparovTopalovMoves(74),
    sideToMove: 'white',
    pieceCount: 14,
    phase: 'endgame',
    difficulty: 'easy',
    source: kasparovTopalovSource(74),
  },
  {
    id: 'sn-kasparov-topalov-2',
    fen: '7r/3r1p1p/6p1/1p6/2B5/5PP1/1Q5P/1K1k4 b - - 0 38',
    pgnMoves: kasparovTopalovMoves(75),
    sideToMove: 'black',
    pieceCount: 13,
    phase: 'endgame',
    difficulty: 'easy',
    source: kasparovTopalovSource(75),
  },
  {
    id: 'sn-kasparov-topalov-3',
    fen: '7r/3r1p1p/6p1/8/2p5/5PP1/1Q5P/1K1k4 w - - 0 39',
    pgnMoves: kasparovTopalovMoves(76),
    sideToMove: 'white',
    pieceCount: 12,
    phase: 'endgame',
    difficulty: 'easy',
    source: kasparovTopalovSource(76),
  },
  {
    id: 'sn-kasparov-topalov-4',
    fen: '7Q/3r1p1p/6p1/8/2p5/5PP1/7P/1K1k4 b - - 0 39',
    pgnMoves: kasparovTopalovMoves(77),
    sideToMove: 'black',
    pieceCount: 11,
    phase: 'endgame',
    difficulty: 'easy',
    source: kasparovTopalovSource(77),
  },
  // --- Donald Byrne vs Bobby Fischer, «Партия века», Нью-Йорк, 1956.10.17.
  {
    id: 'sn-byrne-fischer-1',
    fen: '4r1k1/1p3pbp/1Qp3p1/8/2b5/5N1P/r4nPK/7R w - - 0 28',
    pgnMoves: byrneFischerMoves(54),
    sideToMove: 'white',
    pieceCount: 17,
    phase: 'middlegame',
    difficulty: 'medium',
    source: byrneFischerSource(54),
  },
  {
    id: 'sn-byrne-fischer-2',
    fen: '6k1/1p3pbp/1Qp3p1/8/2b5/5N1P/r4nPK/4r3 w - - 0 29',
    pgnMoves: byrneFischerMoves(56),
    sideToMove: 'white',
    pieceCount: 16,
    phase: 'middlegame',
    difficulty: 'medium',
    source: byrneFischerSource(56),
  },
  // --- снова Kasparov–Topalov, чуть раньше по партии — тот же король ещё
  // не дошёл до края доски, фигур на пять больше, чем в «лёгких» позициях
  // из той же партии.
  {
    id: 'sn-kasparov-topalov-mid',
    fen: '3r3r/1R3p1p/Q5p1/1p6/1kq5/5PPB/2P4P/1K6 w - - 0 33',
    pgnMoves: kasparovTopalovMoves(64),
    sideToMove: 'white',
    pieceCount: 16,
    phase: 'endgame',
    difficulty: 'medium',
    source: kasparovTopalovSource(64),
  },
  // --- Anderssen vs Kieseritzky, «Бессмертная партия», Лондон, 1851.06.21.
  {
    id: 'sn-immortal-game',
    fen: 'r1bk2nr/p2p1pNp/n2B4/1p1NP2P/6P1/3P1Q2/P1P1K3/q5b1 w - - 1 22',
    pgnMoves: immortalMoves(42),
    sideToMove: 'white',
    pieceCount: 24,
    phase: 'middlegame',
    difficulty: 'hard',
    source: immortalSource(42),
  },
];

// --- Ходы партий и источники — вынесены в функции, чтобы не дублировать
// один и тот же массив ходов для нескольких позиций одной партии.

function kasparovTopalovMoves(uptoPly: number): string[] {
  const all = [
    'e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6', 'Be3', 'Bg7', 'Qd2', 'c6', 'f3', 'b5', 'Nge2', 'Nbd7',
    'Bh6', 'Bxh6', 'Qxh6', 'Bb7', 'a3', 'e5', 'O-O-O', 'Qe7', 'Kb1', 'a6', 'Nc1', 'O-O-O', 'Nb3',
    'exd4', 'Rxd4', 'c5', 'Rd1', 'Nb6', 'g3', 'Kb8', 'Na5', 'Ba8', 'Bh3', 'd5', 'Qf4+', 'Ka7',
    'Rhe1', 'd4', 'Nd5', 'Nbxd5', 'exd5', 'Qd6', 'Rxd4', 'cxd4', 'Re7+', 'Kb6', 'Qxd4+', 'Kxa5',
    'b4+', 'Ka4', 'Qc3', 'Qxd5', 'Ra7', 'Bb7', 'Rxb7', 'Qc4', 'Qxf6', 'Kxa3', 'Qxa6+', 'Kxb4',
    'c3+', 'Kxc3', 'Qa1+', 'Kd2', 'Qb2+', 'Kd1', 'Bf1', 'Rd2', 'Rd7', 'Rxd7', 'Bxc4', 'bxc4',
    'Qxh8', 'Rd3', 'Qa8', 'c3', 'Qa4+', 'Ke1', 'f4', 'f5', 'Kc1', 'Rd2', 'Qa7',
  ];
  return all.slice(0, uptoPly);
}
function kasparovTopalovSource(ply: number): SnapshotSource {
  return { white: 'Garry Kasparov', black: 'Veselin Topalov', event: 'Hoogovens (Wijk aan Zee)', date: '1999.01.20', ply };
}

function byrneFischerMoves(uptoPly: number): string[] {
  const all = [
    'Nf3', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'd4', 'O-O', 'Bf4', 'd5', 'Qb3', 'dxc4', 'Qxc4', 'c6',
    'e4', 'Nbd7', 'Rd1', 'Nb6', 'Qc5', 'Bg4', 'Bg5', 'Na4', 'Qa3', 'Nxc3', 'bxc3', 'Nxe4', 'Bxe7',
    'Qb6', 'Bc4', 'Nxc3', 'Bc5', 'Rfe8+', 'Kf1', 'Be6', 'Bxb6', 'Bxc4+', 'Kg1', 'Ne2+', 'Kf1',
    'Nxd4+', 'Kg1', 'Ne2+', 'Kf1', 'Nc3+', 'Kg1', 'axb6', 'Qb4', 'Ra4', 'Qxb6', 'Nxd1', 'h3',
    'Rxa2', 'Kh2', 'Nxf2', 'Re1', 'Rxe1', 'Qd8+', 'Bf8', 'Nxe1', 'Bd5', 'Nf3', 'Ne4', 'Qb8', 'b5',
    'h4', 'h5', 'Ne5', 'Kg7', 'Kg1', 'Bc5+', 'Kf1', 'Ng3+', 'Ke1', 'Bb4+', 'Kd1', 'Bb3+', 'Kc1',
    'Ne2+', 'Kb1', 'Nc3+', 'Kc1', 'Rc2#',
  ];
  return all.slice(0, uptoPly);
}
function byrneFischerSource(ply: number): SnapshotSource {
  return { white: 'Donald Byrne', black: 'Robert James Fischer', event: 'Third Rosenwald Trophy, New York', date: '1956.10.17', ply };
}

function immortalMoves(uptoPly: number): string[] {
  const all = [
    'e4', 'e5', 'f4', 'exf4', 'Bc4', 'Qh4+', 'Kf1', 'b5', 'Bxb5', 'Nf6', 'Nf3', 'Qh6', 'd3', 'Nh5',
    'Nh4', 'Qg5', 'Nf5', 'c6', 'g4', 'Nf6', 'Rg1', 'cxb5', 'h4', 'Qg6', 'h5', 'Qg5', 'Qf3', 'Ng8',
    'Bxf4', 'Qf6', 'Nc3', 'Bc5', 'Nd5', 'Qxb2', 'Bd6', 'Bxg1', 'e5', 'Qxa1+', 'Ke2', 'Na6', 'Nxg7+',
    'Kd8', 'Qf6+', 'Nxf6', 'Be7#',
  ];
  return all.slice(0, uptoPly);
}
function immortalSource(ply: number): SnapshotSource {
  return { white: 'Adolf Anderssen', black: 'Lionel Kieseritzky', event: "«Бессмертная партия», Лондон", date: '1851.06.21', ply };
}
