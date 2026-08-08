import type { Color } from 'chessops/types';

export type PremoveMode = 'forced-capture' | 'safe-unsafe' | 'cancel';

export const PREMOVE_MODE_LABELS: Record<PremoveMode, string> = {
  'forced-capture': 'Форсированное взятие',
  'safe-unsafe': 'Safe и unsafe',
  cancel: 'Отмена',
};

export interface PremovePosition {
  id: string;
  mode: PremoveMode;
  /** Позиция, в которой ход делает соперник. */
  fen: string;
  /** Цвет, за который играет пользователь. Ориентация доски берётся отсюда. */
  userColor: Color;
  /** Ожидаемый ход соперника. Легален в fen. */
  expectedUci: string;
  expectedSan: string;
  /** Правильный ответ пользователя. Легален в позиции после expectedUci. */
  answerUci?: string;
  answerSan?: string;
  /** Прочие правдоподобные ходы соперника, легальные в fen. */
  alternatives?: string[];
  /** Неожиданный ход соперника для режима отмены. Легален в fen. */
  unexpectedUci?: string;
  unexpectedSan?: string;
  /** Верно ли ставить premove в этой позиции. */
  shouldPremove: boolean;
  comment: string;
}

/**
 * Позиции для модуля Premove. Каждая проверяется автотестом
 * tests/premove-positions.test.ts: валидность FEN и легальность
 * ожидаемого, ответного и неожиданного ходов.
 */
export const PREMOVE_POSITIONS: PremovePosition[] = [
  {
    id: 'fc-ruy-bxc6',
    mode: 'forced-capture',
    fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
    userColor: 'black',
    expectedUci: 'b5c6',
    expectedSan: 'Bxc6',
    answerUci: 'd7c6',
    answerSan: 'dxc6',
    shouldPremove: true,
    comment: 'Разменный вариант испанской: на Bxc6 отвечай dxc6.'
  },
  {
    id: 'fc-qgd-cxd5',
    mode: 'forced-capture',
    fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4',
    userColor: 'black',
    expectedUci: 'c4d5',
    expectedSan: 'cxd5',
    answerUci: 'e6d5',
    answerSan: 'exd5',
    shouldPremove: true,
    comment: 'Разменный вариант ферзевого гамбита: на cxd5 бери пешкой e6.'
  },
  {
    id: 'fc-italian-nxd4',
    mode: 'forced-capture',
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/8/2BNP3/8/PPP2PPP/RNBQK2R b KQkq - 0 5',
    userColor: 'white',
    expectedUci: 'c6d4',
    expectedSan: 'Nxd4',
    answerUci: 'd1d4',
    answerSan: 'Qxd4',
    shouldPremove: true,
    comment: 'Размен на d4: конь берёт коня, ты берёшь ферзём.'
  },
  {
    id: 'fc-nimzo-bxc3',
    mode: 'forced-capture',
    fen: 'rnbq1rk1/pppp1ppp/4pn2/8/1bPP4/P1N5/1PQ1PPPP/R1B1KBNR b KQ - 0 5',
    userColor: 'white',
    expectedUci: 'b4c3',
    expectedSan: 'Bxc3+',
    answerUci: 'c2c3',
    answerSan: 'Qxc3',
    shouldPremove: true,
    comment: 'Нимцович с 4.Qc2: на Bxc3+ забирай ферзём.'
  },
  {
    id: 'fc-ruy-nd4',
    mode: 'forced-capture',
    fen: 'r1bqkbnr/pppp1ppp/8/1B2p3/3nP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    userColor: 'black',
    expectedUci: 'f3d4',
    expectedSan: 'Nxd4',
    answerUci: 'e5d4',
    answerSan: 'exd4',
    shouldPremove: true,
    comment: 'Защита Бёрда: на Nxd4 бери пешкой e5.'
  },
  {
    id: 'fc-grunfeld-cxd5',
    mode: 'forced-capture',
    fen: 'rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4',
    userColor: 'black',
    expectedUci: 'c4d5',
    expectedSan: 'cxd5',
    answerUci: 'f6d5',
    answerSan: 'Nxd5',
    shouldPremove: true,
    comment: 'Грюнфельд: на cxd5 бери конём.'
  },
  {
    id: 'fc-italian-bxd2',
    mode: 'forced-capture',
    fen: 'r1bqk2r/pppp1ppp/2n2n2/8/1bBPP3/5N2/PP1B1PPP/RN1QK2R b KQkq - 2 7',
    userColor: 'white',
    expectedUci: 'b4d2',
    expectedSan: 'Bxd2+',
    answerUci: 'b1d2',
    answerSan: 'Nbxd2',
    shouldPremove: true,
    comment: 'Итальянская с d4: на Bxd2+ бей конём b1.'
  },
  {
    id: 'su-forced-kh7-a',
    mode: 'safe-unsafe',
    fen: 'R5k1/5pp1/8/8/8/8/8/6K1 b - - 0 1',
    userColor: 'white',
    expectedUci: 'g8h7',
    expectedSan: 'Kh7',
    answerUci: 'a8a7',
    answerSan: 'Ra7+',
    shouldPremove: true,
    comment: 'У чёрных ровно один легальный ход. Premove безопасен.'
  },
  {
    id: 'su-forced-kh7-b',
    mode: 'safe-unsafe',
    fen: '1R4k1/5pp1/8/8/8/8/8/6K1 b - - 0 1',
    userColor: 'white',
    expectedUci: 'g8h7',
    expectedSan: 'Kh7',
    answerUci: 'b8b7',
    answerSan: 'Rb7+',
    shouldPremove: true,
    comment: 'Снова единственный ход королём. Ставь ответ заранее.'
  },
  {
    id: 'su-forced-kh2',
    mode: 'safe-unsafe',
    fen: '8/8/8/8/8/5k2/6p1/6K1 w - - 0 1',
    userColor: 'black',
    expectedUci: 'g1h2',
    expectedSan: 'Kh2',
    answerUci: 'g2g1q',
    answerSan: 'g1=Q+',
    shouldPremove: true,
    comment: 'У белых единственный ход Kh2. Ферзя можно ставить заранее.'
  },
  {
    id: 'su-ambiguous-bxf6',
    mode: 'safe-unsafe',
    fen: 'rnbqk2r/pppp1pp1/4pB1p/8/1bPP4/2N5/PP2PPPP/R2QKBNR b KQkq - 0 5',
    userColor: 'white',
    expectedUci: 'd8f6',
    expectedSan: 'Qxf6',
    alternatives: [
      'g7f6'
    ],
    shouldPremove: false,
    comment: 'Чёрные бьют ферзём или пешкой g7. Ответ разный, premove не ставим.'
  },
  {
    id: 'su-ambiguous-bxc6',
    mode: 'safe-unsafe',
    fen: 'r1bqkbnr/1ppp1ppp/p1B5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4',
    userColor: 'white',
    expectedUci: 'd7c6',
    expectedSan: 'dxc6',
    alternatives: [
      'b7c6'
    ],
    shouldPremove: false,
    comment: 'Два равноправных взятия на c6. Premove вслепую опасен.'
  },
  {
    id: 'su-ambiguous-exd5',
    mode: 'safe-unsafe',
    fen: 'r1bqkb1r/ppp2ppp/2n2n2/3Pp1N1/2B5/8/PPPP1PPP/RNBQK2R b KQkq - 0 5',
    userColor: 'white',
    expectedUci: 'f6d5',
    expectedSan: 'Nxd5',
    alternatives: [
      'c6a5',
      'b7b5'
    ],
    shouldPremove: false,
    comment: 'Два коня, слон Bb5+ и Na5 — ходов много. Пропускай premove.'
  },
  {
    id: 'cx-ruy-ba4',
    mode: 'cancel',
    fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
    userColor: 'black',
    expectedUci: 'b5c6',
    expectedSan: 'Bxc6',
    answerUci: 'd7c6',
    answerSan: 'dxc6',
    unexpectedUci: 'b5a4',
    unexpectedSan: 'Ba4',
    shouldPremove: true,
    comment: 'Ждёшь Bxc6, но слон отходит на a4. Снимай premove.'
  },
  {
    id: 'cx-qgd-bg5',
    mode: 'cancel',
    fen: 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4',
    userColor: 'black',
    expectedUci: 'c4d5',
    expectedSan: 'cxd5',
    answerUci: 'e6d5',
    answerSan: 'exd5',
    unexpectedUci: 'c1g5',
    unexpectedSan: 'Bg5',
    shouldPremove: true,
    comment: 'Вместо размена на d5 белые развивают слона. Снимай premove.'
  },
  {
    id: 'cx-italian-bc5',
    mode: 'cancel',
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/8/2BNP3/8/PPP2PPP/RNBQK2R b KQkq - 0 5',
    userColor: 'white',
    expectedUci: 'c6d4',
    expectedSan: 'Nxd4',
    answerUci: 'd1d4',
    answerSan: 'Qxd4',
    unexpectedUci: 'f8c5',
    unexpectedSan: 'Bc5',
    shouldPremove: true,
    comment: 'Чёрные не меняются, а развивают слона с темпом. Снимай premove.'
  },
  {
    id: 'cx-nimzo-be7',
    mode: 'cancel',
    fen: 'rnbq1rk1/pppp1ppp/4pn2/8/1bPP4/P1N5/1PQ1PPPP/R1B1KBNR b KQ - 0 5',
    userColor: 'white',
    expectedUci: 'b4c3',
    expectedSan: 'Bxc3+',
    answerUci: 'c2c3',
    answerSan: 'Qxc3',
    unexpectedUci: 'b4e7',
    unexpectedSan: 'Be7',
    shouldPremove: true,
    comment: 'Слон отступает вместо размена. Ферзю на c3 делать нечего.'
  },
  {
    id: 'cx-ruy-nd4-nxe5',
    mode: 'cancel',
    fen: 'r1bqkbnr/pppp1ppp/8/1B2p3/3nP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    userColor: 'black',
    expectedUci: 'f3d4',
    expectedSan: 'Nxd4',
    answerUci: 'e5d4',
    answerSan: 'exd4',
    unexpectedUci: 'f3e5',
    unexpectedSan: 'Nxe5',
    shouldPremove: true,
    comment: 'Белые бьют не коня, а пешку e5. Взятие exd4 стало бессмысленным.'
  },
  {
    id: 'cx-grunfeld-nf3',
    mode: 'cancel',
    fen: 'rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4',
    userColor: 'black',
    expectedUci: 'c4d5',
    expectedSan: 'cxd5',
    answerUci: 'f6d5',
    answerSan: 'Nxd5',
    unexpectedUci: 'g1f3',
    unexpectedSan: 'Nf3',
    shouldPremove: true,
    comment: 'Размена на d5 нет, белые просто развиваются. Снимай premove.'
  },
];

export function positionsOf(mode: PremoveMode): PremovePosition[] {
  return PREMOVE_POSITIONS.filter((p) => p.mode === mode);
}
