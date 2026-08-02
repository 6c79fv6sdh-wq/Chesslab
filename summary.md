# Analysis summary — Blitzscheck

4 games, 225 own moves analysed.

> **Incomplete export.** This PGN is missing:
>
> - clock data (`clocks=true`) — no time-usage section, `time_spent`/`time_left` are empty
> - opening names (`opening=true`) — the by-opening table cannot split
>
> Re-export with those options to fill the gaps. `fetch.py` sets them by default.

## Overall

| metric | value |
|---|---|
| Games | 4 |
| Record (W/D/L) | 3 / 0 / 1 |
| Moves analysed | 225 |
| ACPL (average centipawn loss) | 72 |
| Median centipawn loss | 8 |
| Inaccuracies (>=50cp) | 25.3% |
| Mistakes (>=100cp) | 15.1% |
| Blunders (>=300cp) | 5.3% |
| Engine's top move played | 35.6% |

## By phase

| phase | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| endgame | 123 | 85 | 16.3% | 7.3% |
| middlegame | 43 | 82 | 20.9% | 4.7% |
| opening | 59 | 36 | 8.5% | 1.7% |

## By colour

| colour | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| white | 159 | 82 | 16.4% | 6.3% |
| black | 66 | 46 | 12.1% | 3.0% |

## By game number within a session

_Session = a run of games with less than an hour between them. Rising ACPL down this table is the fatigue/tilt signal._

| game # in session | games | ACPL | blunders |
|---|---|---|---|
| 1 | 1 | 74 | 5.8% |
| 2 | 1 | 47 | 3.8% |
| 3 | 1 | 97 | 7.1% |
| 4 | 1 | 41 | 0.0% |

## By opening

| opening | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| (unknown) | 225 | 72 | 15.1% | 5.3% |

## Worst moments

| game | move | played | engine | loss | phase | clock |
|---|---|---|---|---|---|---|
| [92NP7FSU](https://lichess.org/92NP7FSU) | 24. | Nxf7+ | Nf5+ | 1178 | middlegame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 62. | Rc7 | Re8 | 1059 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 91. | Rc8+ | Kc7 | 990 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 94. | Kg8 | Ke8 | 975 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 93. | Kf8 | Kd8 | 970 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 60. | Rc8 | Kxb8 | 895 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 40. | Rb1 | c4 | 705 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 95. | Rb8 | Kf8 | 663 | endgame | - |
| [cNtoVgfe](https://lichess.org/cNtoVgfe) | 14... | Ng4 | Nxe4 | 610 | opening | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 39. | Rf1 | Kd3 | 514 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 50. | a6 | Kxa7 | 441 | endgame | - |
| [cNtoVgfe](https://lichess.org/cNtoVgfe) | 17... | d5 | Nf5 | 382 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 31. | f3 | Qb3 | 278 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 29. | Rf1 | Rg6 | 267 | middlegame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 99. | Ra4+ | Re5 | 262 | endgame | - |
