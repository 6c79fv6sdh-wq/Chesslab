#!/usr/bin/env python3
"""Self-check for puzzles.py.

Transcriptions are generated backwards from known FENs, so every stage can be
checked against a ground truth: a correct pipeline must return the exact FEN it
was given. Broken cases are included deliberately to prove the rejection paths
fire instead of quietly passing bad positions through.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chess

import puzzles


def transcribe(fen: str, bottom: str) -> dict:
    """Render a FEN into the two independent readings a human would produce."""
    board = chess.Board(fen)
    grid = puzzles.render(board, bottom)
    rows = ["".join(cell or "." for cell in row) for row in grid]
    columns = ["".join(grid[r][c] or "." for r in range(8)) for c in range(8)]
    return {"pass_a": rows, "pass_b": columns, "bottom": bottom}


def case(ident: str, fen: str, bottom: str, **overrides) -> dict:
    entry = {"id": ident, **transcribe(fen, bottom)}
    entry.update(overrides)
    return entry


def corrupt(rows: list[str], row: int, col: int, symbol: str) -> list[str]:
    out = list(rows)
    line = list(out[row])
    line[col] = symbol
    out[row] = "".join(line)
    return out


def main() -> int:
    # (id, fen, bottom, expectation)
    good = [
        ("mate_white_bottom", "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "white"),
        ("mate_black_bottom", "r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1", "black"),
        ("midgame_black_bottom", "2r3k1/5ppp/8/8/8/8/5PPP/2R3K1 b - - 0 1", "black"),
        ("castling_home", "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1", "white"),
    ]

    entries = [case(ident, fen, bottom) for ident, fen, bottom in good]
    expected = {ident: fen for ident, fen, _ in good}

    # --- deliberately broken inputs -------------------------------------------
    base = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1"

    ab = case("disagree_no_third", base, "white")
    ab["pass_b"] = [c.replace("R", "Q", 1) if "R" in c else c for c in ab["pass_b"]]
    entries.append(ab)

    abc = case("disagree_resolved", base, "white")
    abc["pass_c"] = list(abc["pass_a"])
    abc["pass_b"] = [c.replace("R", "Q", 1) if "R" in c else c for c in abc["pass_b"]]
    entries.append(abc)

    three = case("disagree_three_ways", base, "white")
    three["pass_b"] = [c.replace("R", "Q", 1) if "R" in c else c for c in three["pass_b"]]
    three["pass_c"] = corrupt(three["pass_a"], 7, 0, "B")
    entries.append(three)

    two_kings = case("two_white_kings", base, "white")
    two_kings["pass_a"] = corrupt(two_kings["pass_a"], 0, 0, "K")
    two_kings["pass_b"] = [
        "".join(puzzles.rows_to_grid(two_kings["pass_a"])[r][c] or "." for r in range(8))
        for c in range(8)
    ]
    entries.append(two_kings)

    entries.append(case("pawn_on_eighth", "P5k1/8/8/8/8/8/8/R5K1 w - - 0 1", "white"))
    # Black is in check from Re1, but it is White to move: the side that just
    # moved cannot have left itself under attack.
    entries.append(case("idle_side_in_check", "4k3/8/8/8/8/8/8/4R1K1 w - - 0 1", "white"))
    entries.append(
        case("nine_pawns", "6k1/pppppppp/p7/8/8/8/8/R5K1 w - - 0 1", "white")
    )
    # Dead equal: no move is meaningfully better than the next.
    entries.append(case("no_clear_best", "8/8/4k3/8/8/4K3/8/8 w - - 0 1", "white"))

    with tempfile.TemporaryDirectory() as tmp:
        payload = os.path.join(tmp, "cases.json")
        with open(payload, "w", encoding="utf-8") as handle:
            json.dump(entries, handle)

        engine = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "engine/stockfish-bin",
        )
        cmd = [
            sys.executable, os.path.join(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))), "puzzles.py"),
            "--input", payload,
            "--prefix", os.path.join(tmp, "out"),
            "--report", os.path.join(tmp, "report.md"),
            "--engine", engine,
            "--engine-time", "2.0",
            "--per-file", "3",       # small, to prove the file split works
            "--batch", "2",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            return 1

        # Re-run the pipeline in-process so the per-puzzle objects can be checked.
        import argparse

        args = argparse.Namespace(
            engine=engine, engine_time=2.0, no_engine=False,
            prefix=os.path.join(tmp, "chk"), per_file=3, batch=0,
        )
        processed = puzzles.process(entries, args)
        by_id = {p.ident: p for p in processed}

        failures: list[str] = []

        def expect(condition: bool, message: str) -> None:
            if not condition:
                failures.append(message)

        print("=== принятые ===")
        for ident, fen in expected.items():
            p = by_id[ident]
            ok = p.rejected is None and p.fen == fen
            print(f"  {ident:22s} {'OK ' if ok else 'FAIL'} {p.fen or p.rejected}")
            expect(p.rejected is None, f"{ident}: неожиданно забраковано ({p.rejected})")
            expect(p.fen == fen, f"{ident}: FEN {p.fen} != {fen}")

        # Orientation and side to move must follow the bottom of the image.
        for ident, _, bottom in good:
            p = by_id[ident]
            if p.fen:
                turn = p.fen.split()[1]
                expect(
                    turn == ("w" if bottom == "white" else "b"),
                    f"{ident}: сторона хода {turn} не соответствует низу {bottom}",
                )

        print("\n=== забракованные ===")
        must_reject = {
            "disagree_no_third": "disagree",
            "disagree_three_ways": "disagree",
            "two_white_kings": "king",
            "pawn_on_eighth": "pawn on",
            "idle_side_in_check": "in check",
            "nine_pawns": "pawns",
        }
        for ident, fragment in must_reject.items():
            p = by_id[ident]
            ok = p.rejected is not None and fragment in p.rejected
            print(f"  {ident:22s} {'OK ' if ok else 'FAIL'} {p.rejected}")
            expect(p.rejected is not None, f"{ident}: должно было быть забраковано")
            expect(
                p.rejected is not None and fragment in p.rejected,
                f"{ident}: причина {p.rejected!r} не содержит {fragment!r}",
            )

        print("\n=== прочее ===")
        resolved = by_id["disagree_resolved"]
        ok = resolved.rejected is None and resolved.notes
        print(f"  disagree_resolved      {'OK ' if ok else 'FAIL'} {resolved.notes}")
        expect(resolved.rejected is None, "disagree_resolved: должно было пройти по большинству")
        expect(bool(resolved.notes), "disagree_resolved: нет примечания о третьем проходе")

        castle = by_id["castling_home"]
        ok = any("KQkq" in n for n in castle.notes)
        print(f"  castling_home note     {'OK ' if ok else 'FAIL'} {castle.notes}")
        expect(ok, "castling_home: не отмечены возможные рокировки")

        flagged = by_id["no_clear_best"]
        ok = bool(flagged.suspicious)
        print(f"  no_clear_best flag     {'OK ' if ok else 'FAIL'} {flagged.suspicious}")
        expect(ok, "no_clear_best: должно было попасть в подозрительные")

        # Output format: exact tags, no Result, correct chapter split.
        print("\n=== формат вывода ===")
        produced = sorted(
            f for f in os.listdir(tmp) if f.startswith("out_") and f.endswith(".pgn")
        )
        print(f"  файлы: {produced}")
        expect(len(produced) >= 2, "ожидалось несколько файлов при per-file=3")
        text = open(os.path.join(tmp, produced[0]), encoding="utf-8").read()
        print("  --- первая глава ---")
        print("\n".join("  " + l for l in text.strip().splitlines()[:6]))
        expect("[Result" not in text, "в выводе присутствует тег Result")
        for tag in ("[White", "[Black", "[Date", "[Site", "[Round"):
            expect(tag not in text, f"в выводе присутствует запрещённый тег {tag}]")
        for tag in ("[Event ", "[FEN ", "[SetUp \"1\"]", "[Orientation "):
            expect(tag in text, f"в выводе отсутствует обязательный тег {tag}")
        expect(text.rstrip().endswith("*"), "глава не заканчивается на *")

        # Chapters are numbered continuously across files.
        numbers: list[int] = []
        for name in produced:
            body = open(os.path.join(tmp, name), encoding="utf-8").read()
            for line in body.splitlines():
                if line.startswith("[Event "):
                    numbers.append(int(line.split("Задача ")[1].rstrip('"]')))
        expect(
            numbers == list(range(1, len(numbers) + 1)),
            f"сквозная нумерация нарушена: {numbers}",
        )
        print(f"  нумерация: {numbers}")

    print()
    if failures:
        print(f"ПРОВАЛЕНО ({len(failures)}):")
        for message in failures:
            print(f"  - {message}")
        return 1
    print("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
