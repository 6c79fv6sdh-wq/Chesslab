# Chesslab

A pipeline for finding out where your blitz rating actually goes: pull your
games off Lichess, run every position through Stockfish at a fixed time budget,
and reduce the result to one row per move that you can slice however you like.

```
fetch.py  ->  games.pgn  ->  analyze.py  ->  moves.csv  ->  summarize.py  ->  summary.md
```

## Setup

```bash
./setup.sh
```

This creates `.venv`, installs `python-chess`, downloads a Stockfish release
binary into `engine/stockfish-bin`, picks the build variant your CPU can run
(avx512 / bmi2 / avx2 / sse41), marks it executable and verifies it answers
`uci`. Neither the venv nor the ~108 MiB engine is tracked in git.

Override the release with `SF_TAG=sf_17.1 ./setup.sh`.

## Usage

```bash
# 1. Download the 300 most recent rated blitz games
.venv/bin/python fetch.py --user Blitzscheck --max 300 --perf-type blitz

# 2. Analyse every position at 200 ms
.venv/bin/python analyze.py --pgn games.pgn --output moves.csv --movetime 0.2

# 3. Reduce to a readable report
.venv/bin/python summarize.py --csv moves.csv --output summary.md
```

### fetch.py

Wraps the Lichess [game export
endpoint](https://lichess.org/api#tag/Games/operation/apiGamesUser). Sends
`max`, `perfType`, `rated=true`, `clocks=true`, `opening=true` and
`sort=dateDesc`, streams the PGN to disk as it arrives, and backs off for a
minute on HTTP 429. Pass `--token` to use an API token, which raises the rate
limit. `--no-rated`, `--no-clocks` and `--no-opening` turn the respective flags
off if you want a different export.

### analyze.py

Distributes games across a process pool; each worker owns one long-lived
Stockfish process configured to `Threads=1`. Parallelism comes from analysing
many games at once rather than from one deeply parallel search, which keeps the
fixed per-move budget comparable across positions.

Every position is searched **once**. The evaluation of the position after a move
is reused as the evaluation before the next one, so an N-ply game costs N+1
searches instead of 2N — half the engine time, with identical output.

Useful flags: `--movetime` (default 0.2s), `--workers` (default: cores - 1),
`--hash` (MiB per worker), `--limit` (first N games only), `--session-gap`.

### moves.csv

One row per ply, both players' moves. 18 columns:

| column | meaning |
|---|---|
| `game_id` | Lichess game id, from the `Site` header |
| `move_number` | full-move number as printed in the PGN |
| `color` | `white` / `black` — side that played the move |
| `is_mine` | `True` when the mover is `--user` |
| `move` | the move played, SAN |
| `eval_before` | engine evaluation before the move, centipawns, **the mover's** point of view — positive is good for whoever played this move |
| `eval_after` | evaluation after the move, same convention |
| `is_mate_before` | `True` when the position before the move was decided (mate, or past ±1500) |
| `is_mate_after` | `True` when the position after the move was decided |
| `cp_loss` | centipawns lost by the move, never negative |
| `is_critical` | `1` when the opponent's preceding move swung the evaluation by 100+ |
| `best_move` | the engine's preferred move in that position, SAN |
| `phase` | `opening` / `middlegame` / `endgame`, by material |
| `time_spent` | seconds spent on the move |
| `time_left` | seconds left on the mover's clock afterwards |
| `session_game_no` | this game's index within its playing session |
| `opening` | `Opening` header (falls back to `ECO`) |
| `result` | game result as in the PGN (`1-0` / `0-1` / `1/2-1/2`) |

## Conventions worth knowing

**Point of view.** `eval_before` and `eval_after` are stated from the point of
view of the side that played the move: positive means the position favours the
mover. So a game you lost with Black trends negative in its own rows, and
`cp_loss` is a plain `before - after`.

**Mate scores.** Pinned to exactly ±10000 and flagged with `is_mate_before` /
`is_mate_after`. python-chess encodes the distance to mate into the score (mate
in 3 → 9997, mate in 5 → 9995); that distance is not a centipawn quantity, so
it is discarded rather than differenced. A plain centipawn score past ±1500 is
flagged the same way — the engine has not announced mate, but the position is
just as decided and the number just as unusable as a difference.

**Critical positions.** `is_critical` marks a move that answers an opponent move
which shifted the evaluation by 100 centipawns or more: a blunder to punish or a
threat to meet. The swing is measured on clamped scores, so an already-decided
game does not mark everything that follows.

**Centipawn loss** is computed on evaluations clamped to ±1000 — both sides of
the subtraction, so no move can be charged more than 2000. Without the clamp an
already-lost position would generate four-digit losses on every later move. When
the position was mate for the same side both before and after, the loss is 0:
the move kept a forced win (or stayed lost), and only the mating distance moved.

**Phase** is decided by non-pawn material only (3/3/5/9 over both sides, 62 on a
full board): `opening` at 52+, `middlegame` from 24, `endgame` below that.
Material alone, so a queenless position on move 10 counts as an endgame.

**Sessions.** Games are ordered oldest-first and split wherever more than an
hour passes between them (`--session-gap`). `session_game_no` restarts at 1 for
each session, which is what makes "am I worse by game 8?" answerable.

**Clocks.** `time_spent` is derived as `previous clock + increment - current
clock`, reading the `[%clk]` comments that `clocks=true` puts in the PGN, with
the increment taken from the `TimeControl` header.

## Cost

Roughly `(plies + 1) × movetime / workers`. At 200 ms with 3 workers, ~300 blitz
games of ~80 plies works out to about half an hour.
