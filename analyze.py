#!/usr/bin/env python3
"""Run every game in a PGN through Stockfish and emit one CSV row per move.

Each position in a game is evaluated exactly once with a fixed time budget.
The evaluation of the position *before* a move doubles as the evaluation of the
position *after* the previous one, so a game of N plies costs N+1 searches
rather than 2N.

Games are distributed over a process pool; every worker owns one long-lived
engine process so the (slow) UCI handshake is paid once per worker.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

import chess
import chess.engine
import chess.pgn

# --- evaluation conventions --------------------------------------------------

# Mate is reported as a distance, not a centipawn number. Folding it into a
# large finite score keeps the CSV numeric; 10000 is far outside any real eval.
MATE_SCORE = 10000

# Centipawn loss is computed on evaluations clamped to this range. Without a
# clamp, "mate in 5" -> "mate in 3" would register as a huge swing, and a
# position that is already lost by -2000 would generate meaningless four-digit
# losses on every subsequent move. The clamp is applied to *both* sides of the
# subtraction, so no single move can ever be charged more than 2 * EVAL_CLAMP.
EVAL_CLAMP = 1000

# Non-pawn material remaining on the board, counted with the usual 3/3/5/9
# weights over both sides. A full board is 62; these cutoffs split the game
# into roughly equal thirds by material traded.
PHASE_OPENING_MIN = 52
PHASE_MIDDLEGAME_MIN = 24

PIECE_WEIGHTS = {
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
}

# Two games separated by more than this many seconds belong to different
# sitting-down-to-play sessions. Used to derive the per-session game counter.
DEFAULT_SESSION_GAP = 3600

CLOCK_RE = re.compile(r"\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]")

FIELDNAMES = [
    "game_id",
    "move_number",
    "color",
    "is_mine",
    "move",
    "eval_before",
    "eval_after",
    "is_mate_before",
    "is_mate_after",
    "cp_loss",
    "best_move",
    "phase",
    "time_spent",
    "time_left",
    "session_game_no",
    "opening",
    "result",
]


@dataclass
class MoveRow:
    game_id: str
    move_number: int
    color: str
    is_mine: bool
    move: str
    eval_before: int
    eval_after: int
    is_mate_before: bool
    is_mate_after: bool
    cp_loss: int
    best_move: str
    phase: str
    time_spent: float | None
    time_left: float | None
    session_game_no: int
    opening: str
    result: str


# --- helpers -----------------------------------------------------------------


def clamp(value: int) -> int:
    return max(-EVAL_CLAMP, min(EVAL_CLAMP, value))


def phase_of(board: chess.Board) -> str:
    """Classify the position by how much non-pawn material is left."""
    material = 0
    for piece_type, weight in PIECE_WEIGHTS.items():
        material += weight * len(board.pieces(piece_type, chess.WHITE))
        material += weight * len(board.pieces(piece_type, chess.BLACK))
    if material >= PHASE_OPENING_MIN:
        return "opening"
    if material >= PHASE_MIDDLEGAME_MIN:
        return "middlegame"
    return "endgame"


def parse_clock(comment: str) -> float | None:
    """Pull the seconds remaining out of a ``[%clk H:MM:SS]`` comment."""
    match = CLOCK_RE.search(comment or "")
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_time_control(header: str) -> tuple[float | None, float]:
    """Split a PGN TimeControl like ``180+2`` into (base seconds, increment)."""
    if not header or header == "-":
        return None, 0.0
    match = re.match(r"^(\d+)(?:\+(\d+))?$", header.strip())
    if not match:
        return None, 0.0
    base = float(match.group(1))
    increment = float(match.group(2) or 0)
    return base, increment


def game_id_of(game: chess.pgn.Game) -> str:
    """Lichess puts the game id at the end of the Site URL."""
    site = game.headers.get("Site", "")
    if "lichess.org/" in site:
        return site.rstrip("/").rsplit("/", 1)[-1]
    return game.headers.get("GameId", "") or site or "unknown"


def game_datetime(game: chess.pgn.Game) -> datetime | None:
    """Best-effort UTC timestamp for ordering games into sessions."""
    date = game.headers.get("UTCDate") or game.headers.get("Date")
    clock = game.headers.get("UTCTime") or game.headers.get("Time") or "00:00:00"
    if not date or "?" in date:
        return None
    try:
        return datetime.strptime(f"{date} {clock}", "%Y.%m.%d %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def score_cp(score: chess.engine.PovScore) -> tuple[int, bool]:
    """White-relative centipawns, plus whether the score was a mate.

    python-chess encodes the distance to mate into the folded score (mate in 3
    becomes 9997, mate in 5 becomes 9995). That distance is not a centipawn
    quantity and differencing it produces nonsense, so mates are pinned to
    exactly +/-MATE_SCORE and flagged instead.
    """
    pov = score.white()
    if pov.is_mate():
        mate = pov.mate() or 0
        return (MATE_SCORE if mate > 0 else -MATE_SCORE), True
    return pov.score(mate_score=MATE_SCORE), False


# --- worker ------------------------------------------------------------------

_ENGINE: chess.engine.SimpleEngine | None = None
_LIMIT: chess.engine.Limit | None = None


def _init_worker(engine_path: str, movetime: float, hash_mb: int) -> None:
    global _ENGINE, _LIMIT
    # The binary is large and the first handshake can take over ten seconds on a
    # cold page cache, so the default 10s timeout is not enough.
    _ENGINE = chess.engine.SimpleEngine.popen_uci(engine_path, timeout=60)
    # One search thread per worker: parallelism comes from running many games at
    # once, which scales better than one deeply parallel search per game and
    # keeps the fixed time budget comparable across positions.
    _ENGINE.configure({"Threads": 1, "Hash": hash_mb})
    _LIMIT = chess.engine.Limit(time=movetime)


def _shutdown_pool(pool: ProcessPoolExecutor) -> None:
    """Tear the pool down without waiting for workers to exit on their own.

    python-chess drives each engine from a background thread, and CPython joins
    non-daemon threads *before* running ``atexit`` handlers -- so a worker can
    sit forever at interpreter shutdown and a plain ``shutdown(wait=True)``
    never returns. Killing the workers outright is safe at this point: every
    result has already been collected, and each Stockfish child exits by itself
    once its parent dies and it reads EOF on stdin.
    """
    # Captured before shutdown: the executor drops its process table as part of
    # shutting down, and the handles would be gone by the time we need them.
    processes = list((getattr(pool, "_processes", None) or {}).values())
    pool.shutdown(wait=False, cancel_futures=True)
    for process in processes:
        if process.is_alive():
            process.kill()
    for process in processes:
        try:
            process.join(timeout=5)
        except Exception:
            pass


def analyse_game(job: tuple[int, str, int]) -> tuple[int, list[dict], str | None]:
    """Analyse one game. ``job`` is (order index, PGN text, session game number)."""
    index, pgn_text, session_game_no = job
    assert _ENGINE is not None and _LIMIT is not None

    import io

    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return index, [], "unparsable"

    headers = game.headers
    game_id = game_id_of(game)
    result = headers.get("Result", "*")
    opening = headers.get("Opening", "") or headers.get("ECO", "")
    white = headers.get("White", "")
    black = headers.get("Black", "")
    base_time, increment = parse_time_control(headers.get("TimeControl", ""))

    me = os.environ.get("CHESSLAB_USER", "").lower()
    my_color: bool | None = None
    if me and white.lower() == me:
        my_color = chess.WHITE
    elif me and black.lower() == me:
        my_color = chess.BLACK

    nodes = list(game.mainline())
    if len(nodes) < 2:
        return index, [], "too short"

    board = game.board()

    # Evaluate the starting position, then walk forward. At every step the
    # freshly computed evaluation closes out the previous move and opens the
    # next one.
    info = _ENGINE.analyse(board, _LIMIT)
    eval_before, mate_before = score_cp(info["score"])
    best = info.get("pv")
    best_move = board.san(best[0]) if best else ""

    # Clocks start at the base time for both players.
    clock_left = {chess.WHITE: base_time, chess.BLACK: base_time}

    rows: list[dict] = []
    for node in nodes:
        move = node.move
        mover = board.turn
        move_number = board.fullmove_number
        san = board.san(move)
        phase = phase_of(board)

        board.push(move)

        if board.is_game_over():
            # No search needed: the result is known exactly.
            outcome = board.outcome()
            if outcome is not None and outcome.winner is not None:
                eval_after = MATE_SCORE if outcome.winner == chess.WHITE else -MATE_SCORE
                mate_after = True
            else:
                eval_after = 0
                mate_after = False
        else:
            info = _ENGINE.analyse(board, _LIMIT)
            eval_after, mate_after = score_cp(info["score"])

        if mate_before and mate_after and (eval_before > 0) == (eval_after > 0):
            # Mate before and mate for the same side afterwards: the move kept a
            # forced win (or stayed lost). Differencing mate scores would invent
            # a loss out of the change in mating distance, which is not an error.
            cp_loss = 0
        else:
            # Convert to the mover's point of view before differencing, so a loss
            # is always non-negative regardless of who moved. Both sides are
            # clamped first, so an already-decided position cannot manufacture a
            # four-digit loss on every subsequent move.
            sign = 1 if mover == chess.WHITE else -1
            cp_loss = max(0, sign * clamp(eval_before) - sign * clamp(eval_after))

        remaining = parse_clock(node.comment)
        spent: float | None = None
        if remaining is not None:
            previous = clock_left[mover]
            if previous is not None:
                # The clock comment is recorded after the increment is added.
                spent = round(previous + increment - remaining, 2)
            clock_left[mover] = remaining

        rows.append(
            asdict(
                MoveRow(
                    game_id=game_id,
                    move_number=move_number,
                    color="white" if mover == chess.WHITE else "black",
                    is_mine=(my_color is not None and mover == my_color),
                    move=san,
                    eval_before=eval_before,
                    eval_after=eval_after,
                    is_mate_before=mate_before,
                    is_mate_after=mate_after,
                    cp_loss=cp_loss,
                    best_move=best_move,
                    phase=phase,
                    time_spent=spent,
                    time_left=remaining,
                    session_game_no=session_game_no,
                    opening=opening,
                    result=result,
                )
            )
        )

        # Roll forward: this position's evaluation is the next move's "before",
        # and its principal variation is the next move's engine recommendation.
        eval_before, mate_before = eval_after, mate_after
        if not board.is_game_over():
            pv = info.get("pv")
            best_move = board.san(pv[0]) if pv else ""
        else:
            best_move = ""

    return index, rows, None


# --- driver ------------------------------------------------------------------


def split_games(path: str) -> list[tuple[str, datetime | None]]:
    """Split a PGN into per-game text blocks plus each game's timestamp.

    Splitting is done on the text directly rather than by seeking around the
    file: in text mode ``tell()`` returns an opaque cookie, not a character
    offset, so it cannot be used to slice out the bytes a parse consumed.
    """
    import io

    with open(path, encoding="utf-8", errors="replace") as handle:
        content = handle.read()

    chunks: list[str] = []
    current: list[str] = []
    seen_movetext = False
    for line in content.splitlines(keepends=True):
        # A new [Event] tag only starts a new game once the previous block has
        # moved past its own header section.
        if line.startswith("[Event ") and seen_movetext:
            chunks.append("".join(current))
            current = [line]
            seen_movetext = False
            continue
        if current and line.strip() and not line.startswith("["):
            seen_movetext = True
        current.append(line)
    if current and "".join(current).strip():
        chunks.append("".join(current))

    games: list[tuple[str, datetime | None]] = []
    for chunk in chunks:
        game = chess.pgn.read_game(io.StringIO(chunk))
        if game is None or not game.headers.get("Event"):
            continue
        games.append((chunk, game_datetime(game)))
    return games


def assign_sessions(
    stamps: list[datetime | None], gap_seconds: int
) -> list[int]:
    """Number each game within its playing session.

    Games are ordered oldest-first; a gap longer than ``gap_seconds`` between
    consecutive games starts a new session and resets the counter to 1.
    """
    order = sorted(
        range(len(stamps)),
        key=lambda i: (stamps[i] is None, stamps[i] or datetime.min.replace(tzinfo=timezone.utc)),
    )
    numbers = [1] * len(stamps)
    previous: datetime | None = None
    counter = 0
    for position in order:
        stamp = stamps[position]
        if stamp is None or previous is None or (stamp - previous).total_seconds() > gap_seconds:
            counter = 1
        else:
            counter += 1
        numbers[position] = counter
        previous = stamp
    return numbers


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyse a PGN with Stockfish and write one CSV row per move."
    )
    parser.add_argument("--pgn", default="games.pgn", help="input PGN file")
    parser.add_argument("--output", default="moves.csv", help="output CSV file")
    parser.add_argument(
        "--engine", default="engine/stockfish-bin", help="path to the Stockfish binary"
    )
    parser.add_argument(
        "--movetime",
        type=float,
        default=0.2,
        help="fixed search budget per position, in seconds",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 1),
        help="number of parallel engine processes",
    )
    parser.add_argument("--hash", type=int, default=128, help="engine hash, in MiB")
    parser.add_argument(
        "--user",
        default="Blitzscheck",
        help="username whose moves are flagged as mine",
    )
    parser.add_argument(
        "--session-gap",
        type=int,
        default=DEFAULT_SESSION_GAP,
        help="seconds between games that starts a new session",
    )
    parser.add_argument("--limit", type=int, help="analyse only the first N games")
    args = parser.parse_args()

    if not os.path.exists(args.pgn):
        print(f"error: {args.pgn} not found -- run fetch.py first", file=sys.stderr)
        return 1
    if not os.path.exists(args.engine):
        print(f"error: engine not found at {args.engine}", file=sys.stderr)
        return 1

    print(f"reading {args.pgn}", file=sys.stderr)
    games = split_games(args.pgn)
    if args.limit:
        games = games[: args.limit]
    if not games:
        print("error: no games in PGN", file=sys.stderr)
        return 1

    session_numbers = assign_sessions([stamp for _, stamp in games], args.session_gap)
    jobs = [
        (index, text, session_numbers[index])
        for index, (text, _) in enumerate(games)
    ]

    print(
        f"analysing {len(jobs)} games with {args.workers} workers "
        f"at {args.movetime*1000:.0f} ms/move",
        file=sys.stderr,
    )

    # Worker processes read the username from the environment because the pool
    # initializer is shared by every job.
    os.environ["CHESSLAB_USER"] = args.user

    started = time.time()
    collected: dict[int, list[dict]] = {}
    skipped = 0
    done = 0

    pool = ProcessPoolExecutor(
        max_workers=args.workers,
        initializer=_init_worker,
        initargs=(os.path.abspath(args.engine), args.movetime, args.hash),
    )
    try:
        for index, rows, error in pool.map(analyse_game, jobs, chunksize=1):
            done += 1
            if error:
                skipped += 1
            else:
                collected[index] = rows
            elapsed = time.time() - started
            rate = done / elapsed if elapsed else 0
            remaining = (len(jobs) - done) / rate if rate else 0
            print(
                f"\r  {done}/{len(jobs)} games | {sum(len(r) for r in collected.values())} moves"
                f" | {elapsed/60:.1f}m elapsed | ~{remaining/60:.1f}m left   ",
                end="",
                file=sys.stderr,
            )
        print(file=sys.stderr)

        # Written before the pool is torn down: there is no reason to risk
        # finished work on a shutdown step that can misbehave.
        with open(args.output, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
            writer.writeheader()
            for index in sorted(collected):
                writer.writerows(collected[index])
    finally:
        _shutdown_pool(pool)

    total = sum(len(rows) for rows in collected.values())
    print(
        f"wrote {total} moves from {len(collected)} games to {args.output}"
        + (f" ({skipped} skipped)" if skipped else ""),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
