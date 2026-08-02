#!/usr/bin/env python3
"""Turn moves.csv into a human-readable summary.md.

Everything here is descriptive statistics over the rows analyze.py produced --
no engine calls, so it is cheap to re-run with different thresholds.
"""

from __future__ import annotations

import argparse
import csv
import statistics
import sys
from collections import defaultdict

# Centipawn-loss bands. These match the thresholds Lichess uses for its own
# inaccuracy/mistake/blunder annotations closely enough to be recognisable.
INACCURACY = 50
MISTAKE = 100
BLUNDER = 300


def load(path: str, only_mine: bool) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["cp_loss"] = int(row["cp_loss"])
        row["move_number"] = int(row["move_number"])
        row["session_game_no"] = int(row["session_game_no"])
        row["is_mine"] = row["is_mine"] == "True"
        row["time_spent"] = float(row["time_spent"]) if row["time_spent"] else None
        row["time_left"] = float(row["time_left"]) if row["time_left"] else None
    if only_mine:
        rows = [row for row in rows if row["is_mine"]]
    return rows


def acpl(rows: list[dict]) -> float:
    return statistics.mean(row["cp_loss"] for row in rows) if rows else 0.0


def rate(rows: list[dict], threshold: int) -> float:
    if not rows:
        return 0.0
    return 100.0 * sum(1 for row in rows if row["cp_loss"] >= threshold) / len(rows)


def table(headers: list[str], body: list[list[str]]) -> str:
    lines = ["| " + " | ".join(headers) + " |"]
    lines.append("|" + "|".join("---" for _ in headers) + "|")
    for row in body:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def bucket_block(rows: list[dict], key: str, label: str, min_n: int = 1) -> str:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[row[key] or "(unknown)"].append(row)
    body = []
    for name, group in sorted(groups.items(), key=lambda kv: -acpl(kv[1])):
        if len(group) < min_n:
            continue
        body.append(
            [
                name,
                str(len(group)),
                f"{acpl(group):.0f}",
                f"{rate(group, MISTAKE):.1f}%",
                f"{rate(group, BLUNDER):.1f}%",
            ]
        )
    return table([label, "moves", "ACPL", "mistakes", "blunders"], body)


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarise moves.csv into markdown.")
    parser.add_argument("--csv", default="moves.csv")
    parser.add_argument("--output", default="summary.md")
    parser.add_argument("--user", default="Blitzscheck")
    parser.add_argument(
        "--all-moves",
        action="store_true",
        help="include opponent moves instead of only the user's",
    )
    args = parser.parse_args()

    rows = load(args.csv, only_mine=not args.all_moves)
    if not rows:
        print("no rows to summarise")
        return 1

    games = {row["game_id"] for row in rows}
    results = [
        (row["game_id"], row["result"], row["color"]) for row in rows
    ]
    per_game = {game_id: (result, color) for game_id, result, color in results}
    wins = sum(
        1
        for result, color in per_game.values()
        if (result == "1-0" and color == "white") or (result == "0-1" and color == "black")
    )
    draws = sum(1 for result, _ in per_game.values() if result == "1/2-1/2")
    losses = len(per_game) - wins - draws

    timed = [row for row in rows if row["time_spent"] is not None]
    scramble = [row for row in rows if row["time_left"] is not None and row["time_left"] < 30]

    out: list[str] = []
    out.append(f"# Analysis summary — {args.user}\n")
    out.append(
        f"{len(games)} games, {len(rows)} "
        f"{'moves' if args.all_moves else 'own moves'} analysed.\n"
    )

    out.append("## Overall\n")
    out.append(
        table(
            ["metric", "value"],
            [
                ["Games", str(len(games))],
                ["Record (W/D/L)", f"{wins} / {draws} / {losses}"],
                ["Moves analysed", str(len(rows))],
                ["ACPL (average centipawn loss)", f"{acpl(rows):.0f}"],
                ["Median centipawn loss", f"{statistics.median(r['cp_loss'] for r in rows):.0f}"],
                [f"Inaccuracies (>={INACCURACY}cp)", f"{rate(rows, INACCURACY):.1f}%"],
                [f"Mistakes (>={MISTAKE}cp)", f"{rate(rows, MISTAKE):.1f}%"],
                [f"Blunders (>={BLUNDER}cp)", f"{rate(rows, BLUNDER):.1f}%"],
                [
                    "Engine's top move played",
                    f"{100.0*sum(1 for r in rows if r['move']==r['best_move'])/len(rows):.1f}%",
                ],
            ],
        )
    )
    out.append("")

    out.append("## By phase\n")
    out.append(bucket_block(rows, "phase", "phase"))
    out.append("")

    out.append("## By colour\n")
    out.append(bucket_block(rows, "color", "colour"))
    out.append("")

    out.append("## By game number within a session\n")
    out.append(
        "_Session = a run of games with less than an hour between them. "
        "Rising ACPL down this table is the fatigue/tilt signal._\n"
    )
    groups: dict[int, list[dict]] = defaultdict(list)
    for row in rows:
        groups[min(row["session_game_no"], 10)].append(row)
    body = []
    for number in sorted(groups):
        group = groups[number]
        label = "10+" if number == 10 else str(number)
        body.append(
            [
                label,
                str(len({r["game_id"] for r in group})),
                f"{acpl(group):.0f}",
                f"{rate(group, BLUNDER):.1f}%",
            ]
        )
    out.append(table(["game # in session", "games", "ACPL", "blunders"], body))
    out.append("")

    out.append("## By opening\n")
    out.append(bucket_block(rows, "opening", "opening", min_n=20))
    out.append("")

    if timed:
        out.append("## Time usage\n")
        fast = [row for row in timed if row["time_spent"] < 1]
        slow = [row for row in timed if row["time_spent"] >= 5]
        out.append(
            table(
                ["metric", "value"],
                [
                    ["Median time per move", f"{statistics.median(r['time_spent'] for r in timed):.1f}s"],
                    ["Mean time per move", f"{statistics.mean(r['time_spent'] for r in timed):.1f}s"],
                    ["Snap moves (<1s)", f"{100.0*len(fast)/len(timed):.1f}%"],
                    ["ACPL on snap moves", f"{acpl(fast):.0f}"],
                    ["Long thinks (>=5s)", f"{100.0*len(slow)/len(timed):.1f}%"],
                    ["ACPL on long thinks", f"{acpl(slow):.0f}"],
                    ["Moves under 30s on the clock", str(len(scramble))],
                    ["ACPL in time scramble", f"{acpl(scramble):.0f}" if scramble else "n/a"],
                ],
            )
        )
        out.append("")

    out.append("## Worst moments\n")
    worst = sorted(rows, key=lambda r: -r["cp_loss"])[:15]
    out.append(
        table(
            ["game", "move", "played", "engine", "loss", "phase", "clock"],
            [
                [
                    f"[{r['game_id']}](https://lichess.org/{r['game_id']})",
                    f"{r['move_number']}{'.' if r['color']=='white' else '...'}",
                    r["move"],
                    r["best_move"],
                    str(r["cp_loss"]),
                    r["phase"],
                    f"{r['time_left']:.0f}s" if r["time_left"] is not None else "-",
                ]
                for r in worst
            ],
        )
    )
    out.append("")

    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out))
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
