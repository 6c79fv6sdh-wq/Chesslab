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
| ACPL (average centipawn loss) | 57 |
| Median centipawn loss | 7 |
| Inaccuracies (>=50cp) | 22.2% |
| Mistakes (>=100cp) | 14.7% |
| Blunders (>=300cp) | 4.9% |
| Engine's top move played | 34.2% |

## By phase

| phase | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| middlegame | 43 | 77 | 25.6% | 4.7% |
| endgame | 123 | 60 | 13.8% | 6.5% |
| opening | 59 | 36 | 8.5% | 1.7% |

## By colour

| colour | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| white | 159 | 60 | 15.1% | 5.7% |
| black | 66 | 51 | 13.6% | 3.0% |

## By game number within a session

_Session = a run of games with less than an hour between them. Rising ACPL down this table is the fatigue/tilt signal._

| game # in session | games | ACPL | blunders |
|---|---|---|---|
| 1 | 1 | 43 | 4.9% |
| 2 | 1 | 52 | 3.8% |
| 3 | 1 | 91 | 7.1% |
| 4 | 1 | 46 | 0.0% |

## By opening

| opening | moves | ACPL | mistakes | blunders |
|---|---|---|---|---|
| (unknown) | 225 | 57 | 14.7% | 4.9% |

## Worst moments

| game | move | played | engine | loss | phase | clock |
|---|---|---|---|---|---|---|
| [VeL05zD2](https://lichess.org/VeL05zD2) | 99. | Ra4+ | Re5 | 845 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 98. | Ra5+ | Kf7 | 741 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 40. | Rb1 | c4 | 723 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 24. | Nxf7+ | Nf5+ | 661 | middlegame | - |
| [cNtoVgfe](https://lichess.org/cNtoVgfe) | 14... | Ng4 | Nxe4 | 625 | opening | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 95. | Rb8 | Re8 | 548 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 63. | Rc6 | Re7 | 525 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 39. | Rf1 | Kd3 | 496 | endgame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 60. | Rc8 | Kxb8 | 414 | endgame | - |
| [cNtoVgfe](https://lichess.org/cNtoVgfe) | 17... | d5 | Nf5 | 410 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 50. | a6 | Kxa7 | 406 | endgame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 31. | f3 | Rg6 | 292 | middlegame | - |
| [92NP7FSU](https://lichess.org/92NP7FSU) | 29. | Rf1 | Rg6 | 274 | middlegame | - |
| [VeL05zD2](https://lichess.org/VeL05zD2) | 41. | Rxd3 | Rf4+ | 227 | endgame | - |
| [MSYU402A](https://lichess.org/MSYU402A) | 9... | Qe7 | h4 | 195 | opening | - |
