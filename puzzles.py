#!/usr/bin/env python3
"""Turn transcribed puzzle diagrams into PGN files for a Lichess study.

Reading the pieces off a screenshot is the one step a script cannot do; that
transcription is supplied as JSON. Everything downstream of it -- cross-checking
the two independent readings, orienting the board, assembling the FEN, proving
the position legal, rendering it back for comparison, asking the engine whether
the puzzle actually has a point, and writing the chapters out -- happens here.

Input JSON is a list of objects:

    {
      "id":     "puzzle_007.png",
      "pass_a": ["r...k..r", ...],   8 rows, top row of the image first,
                                     each row left to right
      "pass_b": ["r...", ...],       8 columns, left column of the image first,
                                     each column top to bottom
      "pass_c": [...],               optional third reading, same shape as A
      "bottom": "white" | "black",   side at the bottom of the image
      "castling": "KQkq"             optional, defaults to "-"
    }

Pieces use FEN letters (uppercase White, lowercase Black); empty squares are
".", "-", "_" or a space.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field

import chess
import chess.engine

EMPTY = ".-_ "
PIECES = "pnbrqkPNBRQK"

# Engine verdicts. A puzzle whose best move is not clearly better than the
# runner-up has no unique solution worth studying.
MIN_EDGE = 200
# An evaluation this lopsided before the solution even starts usually means a
# piece was misread rather than that the puzzle is genuinely won.
WILD_EVAL = 1000

CHAPTERS_PER_FILE = 64


@dataclass
class Puzzle:
    ident: str
    grid: list[list[str]] | None = None  # as displayed: [row][col], row 0 = top
    bottom: str = "white"
    castling: str = "-"
    fen: str | None = None
    number: int | None = None
    rejected: str | None = None
    suspicious: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


# --- stage 1: reconcile the two readings -------------------------------------


def normalise_row(row: str) -> list[str]:
    """Turn one transcribed line into eight single-character cells."""
    cells = [("" if ch in EMPTY else ch) for ch in row.strip()]
    if len(cells) != 8:
        raise ValueError(f"expected 8 cells, got {len(cells)}: {row!r}")
    for cell in cells:
        if cell and cell not in PIECES:
            raise ValueError(f"unknown piece letter {cell!r} in {row!r}")
    return cells


def rows_to_grid(rows: list[str]) -> list[list[str]]:
    if len(rows) != 8:
        raise ValueError(f"expected 8 rows, got {len(rows)}")
    return [normalise_row(row) for row in rows]


def columns_to_grid(columns: list[str]) -> list[list[str]]:
    """Transpose a file-wise reading into the same [row][col] frame as pass A."""
    if len(columns) != 8:
        raise ValueError(f"expected 8 columns, got {len(columns)}")
    cols = [normalise_row(column) for column in columns]
    return [[cols[c][r] for c in range(8)] for r in range(8)]


def reconcile(puzzle: Puzzle, raw: dict) -> list[list[str]] | None:
    """Cross-check the independent readings; return the agreed grid or None.

    Two readings that agree are taken as correct. When they disagree a third
    reading breaks the tie, cell by cell -- but only where exactly one value has
    two votes. A cell where all three readings differ has no majority and
    condemns the whole puzzle.
    """
    grid_a = rows_to_grid(raw["pass_a"])
    grid_b = columns_to_grid(raw["pass_b"])

    if grid_a == grid_b:
        return grid_a

    disagreements = [
        f"{chr(ord('a')+c)}{8-r}" if puzzle.bottom == "white" else f"r{r+1}c{c+1}"
        for r in range(8)
        for c in range(8)
        if grid_a[r][c] != grid_b[r][c]
    ]

    if "pass_c" not in raw:
        puzzle.rejected = (
            f"passes A and B disagree on {len(disagreements)} square(s) "
            f"({', '.join(disagreements[:6])}) and no third reading was supplied"
        )
        return None

    grid_c = rows_to_grid(raw["pass_c"])
    resolved: list[list[str]] = []
    unresolved: list[str] = []
    for r in range(8):
        row: list[str] = []
        for c in range(8):
            votes = [grid_a[r][c], grid_b[r][c], grid_c[r][c]]
            winner = next((v for v in votes if votes.count(v) >= 2), None)
            if winner is None:
                unresolved.append(f"r{r+1}c{c+1}")
                row.append("")
            else:
                row.append(winner)
        resolved.append(row)

    if unresolved:
        puzzle.rejected = (
            f"three readings still disagree on {len(unresolved)} square(s): "
            f"{', '.join(unresolved[:6])}"
        )
        return None

    puzzle.notes.append(
        f"passes A/B differed on {len(disagreements)} square(s), resolved by third reading"
    )
    return resolved


# --- stages 2 and 3: orientation and FEN --------------------------------------


def square_of(row: int, col: int, bottom: str) -> chess.Square:
    """Map a display cell to a board square, honouring the board's orientation.

    With White at the bottom the top-left of the image is a8. With Black at the
    bottom the board is turned around, so the top-left is h1 and both axes run
    the other way.
    """
    if bottom == "white":
        file_index, rank_index = col, 7 - row
    else:
        file_index, rank_index = 7 - col, row
    return chess.square(file_index, rank_index)


def build_board(puzzle: Puzzle) -> chess.Board:
    board = chess.Board(None)
    assert puzzle.grid is not None
    for r in range(8):
        for c in range(8):
            symbol = puzzle.grid[r][c]
            if symbol:
                board.set_piece_at(
                    square_of(r, c, puzzle.bottom), chess.Piece.from_symbol(symbol)
                )
    # The side at the bottom of the image is the side solving the puzzle, so it
    # is the side to move.
    board.turn = chess.WHITE if puzzle.bottom == "white" else chess.BLACK
    board.castling_rights = chess.BB_EMPTY
    if puzzle.castling and puzzle.castling != "-":
        board.set_castling_fen(puzzle.castling)
    board.ep_square = None
    board.halfmove_clock = 0
    board.fullmove_number = 1
    return board


def implied_castling(board: chess.Board) -> str:
    """Castling rights that the piece placement alone would allow."""
    rights = ""
    checks = [
        ("K", chess.E1, chess.H1, chess.WHITE),
        ("Q", chess.E1, chess.A1, chess.WHITE),
        ("k", chess.E8, chess.H8, chess.BLACK),
        ("q", chess.E8, chess.A8, chess.BLACK),
    ]
    for letter, king_sq, rook_sq, colour in checks:
        king = board.piece_at(king_sq)
        rook = board.piece_at(rook_sq)
        if (
            king
            and king.piece_type == chess.KING
            and king.color == colour
            and rook
            and rook.piece_type == chess.ROOK
            and rook.color == colour
        ):
            rights += letter
    return rights or "-"


# --- stage 4: legality --------------------------------------------------------


def count_problems(board: chess.Board, colour: chess.Color) -> str | None:
    """Reject material that no legal game could have produced."""
    counts = {
        piece_type: len(board.pieces(piece_type, colour))
        for piece_type in (chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)
    }
    name = "white" if colour == chess.WHITE else "black"
    if counts[chess.PAWN] > 8:
        return f"{name} has {counts[chess.PAWN]} pawns"
    total = sum(counts.values()) + 1
    if total > 16:
        return f"{name} has {total} pieces"
    # Every piece beyond the starting complement has to be a promoted pawn, and
    # there are only eight pawns to promote.
    promotions = (
        max(0, counts[chess.KNIGHT] - 2)
        + max(0, counts[chess.BISHOP] - 2)
        + max(0, counts[chess.ROOK] - 2)
        + max(0, counts[chess.QUEEN] - 1)
    )
    if counts[chess.PAWN] + promotions > 8:
        return (
            f"{name} needs {promotions} promotion(s) but still has "
            f"{counts[chess.PAWN]} pawns"
        )
    return None


def check_legality(board: chess.Board) -> str | None:
    for colour, name in ((chess.WHITE, "white"), (chess.BLACK, "black")):
        kings = len(board.pieces(chess.KING, colour))
        if kings != 1:
            return f"{kings} {name} king(s)"

    for square in chess.SquareSet(chess.BB_RANK_1 | chess.BB_RANK_8):
        piece = board.piece_at(square)
        if piece and piece.piece_type == chess.PAWN:
            return f"pawn on {chess.square_name(square)}"

    for colour in (chess.WHITE, chess.BLACK):
        problem = count_problems(board, colour)
        if problem:
            return problem

    # The side that has just moved cannot still be under attack.
    if board.was_into_check():
        idle = "black" if board.turn == chess.WHITE else "white"
        return f"{idle} is in check but it is not their move"

    if not board.is_valid():
        return f"python-chess rejects the position: {board.status()!r}"

    return None


# --- stage 5: render back and compare -----------------------------------------


def render(board: chess.Board, bottom: str) -> list[list[str]]:
    """Draw the board back out in the same display frame it was read in."""
    grid: list[list[str]] = []
    for r in range(8):
        row: list[str] = []
        for c in range(8):
            piece = board.piece_at(square_of(r, c, bottom))
            row.append(piece.symbol() if piece else "")
        grid.append(row)
    return grid


def as_text(grid: list[list[str]]) -> str:
    return "\n".join(" ".join(cell or "." for cell in row) for row in grid)


def verify_render(puzzle: Puzzle, board: chess.Board) -> str | None:
    assert puzzle.grid is not None
    drawn = render(board, puzzle.bottom)
    mismatches = [
        f"r{r+1}c{c+1}: read {puzzle.grid[r][c] or '.'} vs drawn {drawn[r][c] or '.'}"
        for r in range(8)
        for c in range(8)
        if puzzle.grid[r][c] != drawn[r][c]
    ]
    if mismatches:
        return f"round-trip mismatch on {len(mismatches)} square(s): {mismatches[0]}"
    return None


# --- stage 6: engine ----------------------------------------------------------


def engine_check(
    engine: chess.engine.SimpleEngine, board: chess.Board, seconds: float
) -> list[str]:
    """Flag puzzles whose solution is not clear-cut, or whose position is wild."""
    flags: list[str] = []
    try:
        infos = engine.analyse(
            board, chess.engine.Limit(time=seconds), multipv=2
        )
    except chess.engine.EngineError as exc:
        return [f"engine refused the position: {exc}"]

    if not infos:
        return ["engine returned nothing"]

    best = infos[0]["score"].pov(board.turn)
    best_cp = best.score(mate_score=100000)

    if best.is_mate():
        # A forced mate is a fine puzzle whatever the runner-up looks like.
        pass
    elif len(infos) < 2:
        flags.append("only one legal move, nothing to choose between")
    else:
        second = infos[1]["score"].pov(board.turn)
        if second.is_mate() and second.mate() and second.mate() > 0:
            flags.append("second line also mates: solution is not unique")
        else:
            edge = best_cp - second.score(mate_score=100000)
            if edge < MIN_EDGE:
                flags.append(
                    f"best move only {edge}cp better than the second (< {MIN_EDGE})"
                )

    if not best.is_mate() and abs(best_cp) > WILD_EVAL:
        flags.append(
            f"position already {best_cp/100:+.1f} before the solution — likely a misread piece"
        )

    return flags


# --- stage 7: output ----------------------------------------------------------


def write_pgn(puzzles: list[Puzzle], prefix: str, per_file: int) -> list[str]:
    """Write the accepted puzzles out in chapter-sized files."""
    written: list[str] = []
    for index in range(0, len(puzzles), per_file):
        batch = puzzles[index : index + per_file]
        path = f"{prefix}_{index // per_file + 1:02d}.pgn"
        with open(path, "w", encoding="utf-8") as handle:
            for puzzle in batch:
                # Written by hand rather than through python-chess: the exporter
                # always emits a Result tag, and that breaks the board
                # auto-flip on import.
                handle.write(f'[Event "Задача {puzzle.number}"]\n')
                handle.write(f'[FEN "{puzzle.fen}"]\n')
                handle.write('[SetUp "1"]\n')
                handle.write(f'[Orientation "{puzzle.bottom}"]\n')
                handle.write("\n*\n\n")
        written.append(path)
    return written


# --- driver -------------------------------------------------------------------


def process(raw_puzzles: list[dict], args: argparse.Namespace) -> list[Puzzle]:
    engine = None
    if not args.no_engine:
        engine = chess.engine.SimpleEngine.popen_uci(args.engine, timeout=60)
        engine.configure({"Threads": 1, "Hash": 128})

    processed: list[Puzzle] = []
    accepted = 0
    try:
        for position, raw in enumerate(raw_puzzles, start=1):
            puzzle = Puzzle(
                ident=raw.get("id", f"#{position}"),
                bottom=raw.get("bottom", "white"),
                castling=raw.get("castling", "-"),
            )
            processed.append(puzzle)

            if puzzle.bottom not in ("white", "black"):
                puzzle.rejected = f"bottom must be white or black, got {puzzle.bottom!r}"
                continue

            try:
                grid = reconcile(puzzle, raw)
            except (ValueError, KeyError) as exc:
                puzzle.rejected = f"unreadable transcription: {exc}"
                continue
            if grid is None:
                continue
            puzzle.grid = grid

            board = build_board(puzzle)

            if puzzle.castling == "-":
                implied = implied_castling(board)
                if implied != "-":
                    puzzle.notes.append(
                        f"kings and rooks sit on their home squares; castling left at "
                        f'"-" but {implied} would be available'
                    )

            problem = check_legality(board)
            if problem:
                puzzle.rejected = f"illegal position: {problem}"
                continue

            mismatch = verify_render(puzzle, board)
            if mismatch:
                puzzle.rejected = mismatch
                continue

            puzzle.fen = board.fen()
            if engine is not None:
                puzzle.suspicious = engine_check(engine, board, args.engine_time)

            accepted += 1
            puzzle.number = accepted

            if args.batch and accepted % args.batch == 0:
                flush(processed, args)
                print(f"  ... {accepted} accepted, interim files written", file=sys.stderr)
    finally:
        if engine is not None:
            process_engine = engine.transport.get_extra_info("subprocess")
            engine.close()
            if process_engine is not None and process_engine.poll() is None:
                process_engine.kill()

    return processed


def flush(processed: list[Puzzle], args: argparse.Namespace) -> list[str]:
    good = [p for p in processed if p.rejected is None and p.fen]
    return write_pgn(good, args.prefix, args.per_file)


def report(processed: list[Puzzle], files: list[str]) -> str:
    good = [p for p in processed if p.rejected is None and p.fen]
    bad = [p for p in processed if p.rejected]
    flagged = [p for p in good if p.suspicious]

    lines = ["# Отчёт по сборке задач\n"]
    lines.append(f"- всего изображений: {len(processed)}")
    lines.append(f"- распознано и записано: {len(good)}")
    lines.append(f"- забраковано: {len(bad)}")
    lines.append(f"- помечено как подозрительные: {len(flagged)}")
    lines.append(f"- файлов: {', '.join(files) if files else '—'}\n")

    if bad:
        lines.append("## Забракованные\n")
        lines.append("| изображение | причина |")
        lines.append("|---|---|")
        for puzzle in bad:
            lines.append(f"| {puzzle.ident} | {puzzle.rejected} |")
        lines.append("")

    if flagged:
        lines.append("## Подозрительные\n")
        lines.append("| № | изображение | замечание |")
        lines.append("|---|---|---|")
        for puzzle in flagged:
            lines.append(
                f"| {puzzle.number} | {puzzle.ident} | {'; '.join(puzzle.suspicious)} |"
            )
        lines.append("")

    notes = [p for p in good if p.notes]
    if notes:
        lines.append("## Примечания\n")
        lines.append("| № | изображение | примечание |")
        lines.append("|---|---|---|")
        for puzzle in notes:
            lines.append(f"| {puzzle.number} | {puzzle.ident} | {'; '.join(puzzle.notes)} |")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Assemble Lichess study PGNs from transcribed puzzle diagrams."
    )
    parser.add_argument("--input", required=True, help="JSON file of transcriptions")
    parser.add_argument("--prefix", default="puzzles", help="output file prefix")
    parser.add_argument(
        "--per-file",
        type=int,
        default=CHAPTERS_PER_FILE,
        help="chapters per PGN file (Lichess study limit is 64)",
    )
    parser.add_argument("--engine", default="engine/stockfish-bin")
    parser.add_argument(
        "--engine-time", type=float, default=2.0, help="seconds per position"
    )
    parser.add_argument(
        "--no-engine", action="store_true", help="skip the engine sanity pass"
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=10,
        help="write interim files after this many accepted puzzles (0 to disable)",
    )
    parser.add_argument("--report", default="puzzles_report.md")
    args = parser.parse_args()

    with open(args.input, encoding="utf-8") as handle:
        raw_puzzles = json.load(handle)

    print(f"обрабатываю {len(raw_puzzles)} задач", file=sys.stderr)
    processed = process(raw_puzzles, args)
    files = flush(processed, args)

    text = report(processed, files)
    with open(args.report, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
