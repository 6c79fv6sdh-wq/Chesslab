import type { Color } from 'chessops/types';

export interface OpeningLine {
  id: string;
  name: string;
  /** Ходы в SAN от начальной позиции, начиная с хода белых. */
  sans: string[];
}

export interface Repertoire {
  id: string;
  label: string;
  /** Цвет, за который играет пользователь. Ориентация доски берётся отсюда. */
  userColor: Color;
  lines: OpeningLine[];
}

/**
 * Репертуары дебютного автомата. Каждая линия проигрывается движком
 * в tests/repertoire.test.ts: каждый SAN обязан быть легален.
 * Загрузка своего PGN в первой версии не предусмотрена.
 */
export const REPERTOIRES: Repertoire[] = [
  {
    id: 'white-e4',
    label: 'Белыми 1.e4',
    userColor: 'white',
    lines: [
      {
        id: 'italian-giuoco',
        name: 'Итальянская, тихая линия',
        sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'],
      },
      {
        id: 'two-knights-ng5',
        name: 'Два коня, 4.Ng5',
        sans: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Na5',
          'Bb5+', 'c6', 'dxc6', 'bxc6',
        ],
      },
      {
        id: 'petrov',
        name: 'Русская партия',
        sans: [
          'e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4', 'd4', 'd5',
          'Bd3', 'Be7', 'O-O', 'O-O',
        ],
      },
      {
        id: 'philidor',
        name: 'Защита Филидора',
        sans: [
          'e4', 'e5', 'Nf3', 'd6', 'd4', 'Nf6', 'Nc3', 'Nbd7', 'Bc4', 'Be7', 'O-O', 'O-O',
        ],
      },
      {
        id: 'sicilian-najdorf',
        name: 'Сицилианская, Найдорф',
        sans: [
          'e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6',
          'Be3', 'e5', 'Nb3', 'Be7',
        ],
      },
      {
        id: 'sicilian-sveshnikov',
        name: 'Сицилианская, Свешников',
        sans: [
          'e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e5',
          'Ndb5', 'd6', 'Bg5', 'a6', 'Na3', 'b5',
        ],
      },
      {
        id: 'french-winawer',
        name: 'Французская, Винавер',
        sans: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4', 'e5', 'c5', 'a3', 'Bxc3+', 'bxc3', 'Ne7'],
      },
      {
        id: 'french-classical',
        name: 'Французская, классика',
        sans: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e5', 'Nfd7', 'Bxe7', 'Qxe7'],
      },
      {
        id: 'caro-kann-classical',
        name: 'Каро-Канн, классика',
        sans: [
          'e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6',
          'h4', 'h6', 'Nf3', 'Nd7',
        ],
      },
      {
        id: 'scandinavian',
        name: 'Скандинавская',
        sans: [
          'e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6', 'Nf3', 'c6',
          'Bc4', 'Bf5', 'Bd2', 'e6',
        ],
      },
      {
        id: 'pirc',
        name: 'Защита Пирца',
        sans: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6', 'Nf3', 'Bg7', 'Be2', 'O-O', 'O-O', 'c6'],
      },
      {
        id: 'alekhine',
        name: 'Защита Алехина',
        sans: [
          'e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'Nf3', 'g6', 'Bc4', 'Nb6',
          'Bb3', 'Bg7', 'Ng5', 'e6', 'f4',
        ],
      },
    ],
  },
  {
    id: 'black-vs-e4',
    label: 'Чёрными против 1.e4',
    userColor: 'black',
    lines: [
      {
        id: 'ruy-morphy',
        name: 'Испанская, защита Морфи',
        sans: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
          'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O',
        ],
      },
      {
        id: 'ruy-exchange',
        name: 'Испанская, разменный вариант',
        sans: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O', 'f6',
          'd4', 'exd4', 'Nxd4', 'c5',
        ],
      },
      {
        id: 'italian-black',
        name: 'Итальянская за чёрных',
        sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O'],
      },
      {
        id: 'two-knights-black',
        name: 'Два коня против 4.Ng5',
        sans: [
          'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Na5',
          'Bb5+', 'c6', 'dxc6', 'bxc6',
        ],
      },
      {
        id: 'scotch-black',
        name: 'Шотландская партия',
        sans: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Bc5', 'Be3', 'Qf6', 'c3', 'Nge7'],
      },
      {
        id: 'kings-gambit-black',
        name: 'Королевский гамбит принятый',
        sans: ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'd5', 'exd5', 'Nf6', 'Bc4', 'Nxd5'],
      },
      {
        id: 'vienna-black',
        name: 'Венская партия',
        sans: ['e4', 'e5', 'Nc3', 'Nf6', 'f4', 'd5', 'fxe5', 'Nxe4', 'Nf3', 'Be7'],
      },
      {
        id: 'four-knights-black',
        name: 'Дебют четырёх коней',
        sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Bb5', 'Bb4', 'O-O', 'O-O', 'd3', 'd6'],
      },
      {
        id: 'bishops-opening-black',
        name: 'Дебют слона',
        sans: ['e4', 'e5', 'Bc4', 'Nf6', 'd3', 'c6', 'Nf3', 'd5', 'Bb3', 'Bd6'],
      },
      {
        id: 'ponziani-black',
        name: 'Дебют Понциани',
        sans: ['e4', 'e5', 'Nf3', 'Nc6', 'c3', 'Nf6', 'd4', 'Nxe4', 'd5', 'Ne7'],
      },
    ],
  },
  {
    id: 'black-vs-d4',
    label: 'Чёрными против 1.d4',
    userColor: 'black',
    lines: [
      {
        id: 'nimzo-rubinstein',
        name: 'Нимцович, система Рубинштейна',
        sans: [
          'd4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5',
          'Nf3', 'c5', 'O-O', 'Nc6',
        ],
      },
      {
        id: 'nimzo-qc2',
        name: 'Нимцович, 4.Qc2',
        sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'Qc2', 'O-O', 'a3', 'Bxc3+', 'Qxc3', 'b6'],
      },
      {
        id: 'queens-indian',
        name: 'Новоиндийская защита',
        sans: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6', 'g3', 'Ba6', 'b3', 'Bb4+', 'Bd2', 'Be7'],
      },
      {
        id: 'catalan',
        name: 'Каталонское начало',
        sans: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'Be7', 'Nf3', 'O-O', 'O-O', 'dxc4'],
      },
      {
        id: 'london',
        name: 'Лондонская система',
        sans: ['d4', 'Nf6', 'Bf4', 'e6', 'e3', 'c5', 'c3', 'd5', 'Nd2', 'Nc6', 'Ngf3', 'Bd6'],
      },
      {
        id: 'torre',
        name: 'Атака Торре',
        sans: ['d4', 'Nf6', 'Nf3', 'e6', 'Bg5', 'c5', 'e3', 'Be7', 'Nbd2', 'b6'],
      },
      {
        id: 'trompowsky',
        name: 'Атака Тромповского',
        sans: ['d4', 'Nf6', 'Bg5', 'e6', 'e4', 'h6', 'Bxf6', 'Qxf6', 'Nf3', 'd6'],
      },
      {
        id: 'colle',
        name: 'Система Колле',
        sans: ['d4', 'Nf6', 'Nf3', 'e6', 'e3', 'c5', 'Bd3', 'd5', 'c3', 'Nc6', 'Nbd2', 'Bd6'],
      },
      {
        id: 'veresov',
        name: 'Дебют Вересова',
        sans: ['d4', 'Nf6', 'Nc3', 'd5', 'Bg5', 'Nbd7', 'Nf3', 'e6', 'e3', 'Be7'],
      },
      {
        id: 'bg5-anti-nimzo',
        name: '4.Bg5 против системы с e6',
        sans: ['d4', 'Nf6', 'c4', 'e6', 'Bg5', 'h6', 'Bh4', 'Bb4+', 'Nc3', 'c5'],
      },
    ],
  },
];

export function repertoireById(id: string): Repertoire | undefined {
  return REPERTOIRES.find((r) => r.id === id);
}
