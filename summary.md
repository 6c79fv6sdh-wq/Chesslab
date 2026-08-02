# Analysis summary — Blitzscheck

6 games, 289 own moves analysed.

> **Incomplete export.** This PGN is missing:
>
> - clock data (`clocks=true`) — no time-usage section, `time_spent`/`time_left` are empty
> - opening names (`opening=true`) — the by-opening table cannot split
>
> Re-export with those options to fill the gaps. `fetch.py` sets them by default.

## Overall

| metric | value |
|---|---|
| Games | 6 |
| Record (W/D/L) | 5 / 0 / 1 |
| Moves analysed | 289 |
| ACPL (average centipawn loss) | 56 |
| Median centipawn loss | 7 |
| Inaccuracies (>=50cp) | 24.2% |
| Mistakes (>=100cp) | 15.2% |
| Blunders (>=300cp) | 3.8% |
| Engine's top move played | 42.6% |

## By phase

| phase | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| middlegame | 66 | 94 | 30.3% | 6.1% |
| endgame | 140 | 51 | 11.4% | 4.3% |
| opening | 83 | 34 | 9.6% | 1.2% |

## By colour

| colour | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| white | 223 | 58 | 15.7% | 4.0% |
| black | 66 | 47 | 13.6% | 3.0% |

## By game number within a session

_Session = a run of games with less than an hour between them. Rising ACPL down this table is the fatigue/tilt signal._

| game # in session | games | ACPL | blunders |
|---|---|---|---|
| 1 | 2 | 38 | 2.1% |
| 2 | 2 | 67 | 5.4% |
| 3 | 1 | 92 | 7.1% |
| 4 | 1 | 40 | 0.0% |

## By opening

| opening | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| (unknown) | 289 | 56 | 15.2% | 3.8% |

## Worst moments

| game | move | played | engine | loss | phase | clock |
|---|---|---|---|---|---|---|
| [oOW508JM](https://lichess.org/oOW508JM) | 19. | Nxh3 | Qxa8+ | 1006 | middlegame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 98. | Ra5+ | Kf7 | 846 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 99. | Ra4+ | Kf7 | 836 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 40. | Rb1 | c4 | 711 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 24. | Nxf7+ | Nf5+ | 657 | middlegame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 96. | Ra8 | Rb5 | 637 | endgame | - |
| [cNtoVgfe](https://lichess.org/cNtoVgfe) | 14... | Ng4 | Nxe4 | 624 | opening | - |
| [oOW508JM](https://lichess.org/oOW508JM) | 20. | Re2 | Qxa8+ | 514 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 39. | Rf1 | Kd3 | 501 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 50. | a6 | Kxa7 | 468 | endgame | - |
| [cNtoVgfe](https://lichess.org/cNtoVgfe) | 17... | d5 | Nf5 | 367 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 31. | f3 | Qf3 | 288 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 29. | Rf1 | Rg6 | 254 | middlegame | - |
| [zKK8HEU1](https://lichess.org/zKK8HEU1) | 22. | Be4 | Na3 | 248 | middlegame | - |
| [zKK8HEU1](https://lichess.org/zKK8HEU1) | 18. | d3 | b3 | 240 | middlegame | - |
