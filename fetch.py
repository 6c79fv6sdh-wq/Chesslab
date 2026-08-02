#!/usr/bin/env python3
"""Download games for a Lichess user into a PGN file.

Uses the public game-export endpoint:
    https://lichess.org/api/games/user/<username>

The endpoint streams PGN, newest game first when ``sort=dateDesc``. Games are
written to disk as they arrive so a long export never has to be buffered whole.
"""

from __future__ import annotations

import argparse
import sys
import time

import requests

API_URL = "https://lichess.org/api/games/user/{user}"

# Lichess asks for a descriptive UA so it can contact operators of noisy clients.
USER_AGENT = "chesslab-fetch/1.0 (+https://github.com/6c79fv6sdh-wq/chesslab)"

# The export endpoint is rate limited; on 429 the docs ask for a full minute of
# backoff before the next attempt.
RATE_LIMIT_WAIT = 60
MAX_ATTEMPTS = 5


def build_params(args: argparse.Namespace) -> dict[str, str]:
    """Assemble the query string.

    Booleans have to be sent as the lowercase literals ``true``/``false`` --
    Python's ``str(True)`` would produce ``True``, which Lichess rejects.
    """
    params = {
        "max": str(args.max),
        "rated": "true" if args.rated else "false",
        "clocks": "true" if args.clocks else "false",
        "opening": "true" if args.opening else "false",
        "sort": args.sort,
    }
    if args.perf_type:
        params["perfType"] = args.perf_type
    if args.since:
        params["since"] = str(args.since)
    if args.until:
        params["until"] = str(args.until)
    return params


def fetch(args: argparse.Namespace) -> int:
    """Stream the export to ``args.output``. Returns the number of games seen."""
    url = API_URL.format(user=args.user)
    params = build_params(args)
    headers = {"Accept": "application/x-chess-pgn", "User-Agent": USER_AGENT}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    print(f"GET {url}", file=sys.stderr)
    print(f"    params: {params}", file=sys.stderr)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with requests.get(
                url, params=params, headers=headers, stream=True, timeout=(15, 180)
            ) as response:
                if response.status_code == 429:
                    print(
                        f"    rate limited (429), sleeping {RATE_LIMIT_WAIT}s "
                        f"[attempt {attempt}/{MAX_ATTEMPTS}]",
                        file=sys.stderr,
                    )
                    time.sleep(RATE_LIMIT_WAIT)
                    continue
                response.raise_for_status()

                games = 0
                bytes_written = 0
                # Write text mode so PGN line endings are normalised for the
                # platform; the API always sends UTF-8.
                with open(args.output, "w", encoding="utf-8") as handle:
                    for chunk in response.iter_content(chunk_size=64 * 1024):
                        if not chunk:
                            continue
                        text = chunk.decode("utf-8", errors="replace")
                        handle.write(text)
                        bytes_written += len(chunk)
                        # Every game carries exactly one Event tag, so counting
                        # them is an accurate running total.
                        games += text.count('[Event "')
                        print(
                            f"\r    {games} games, {bytes_written/1024:.0f} KiB",
                            end="",
                            file=sys.stderr,
                        )
                print(file=sys.stderr)
                return games

        except (requests.ConnectionError, requests.Timeout) as exc:
            if attempt == MAX_ATTEMPTS:
                raise
            backoff = 2**attempt
            print(
                f"    network error ({exc.__class__.__name__}), retrying in "
                f"{backoff}s [attempt {attempt}/{MAX_ATTEMPTS}]",
                file=sys.stderr,
            )
            time.sleep(backoff)

    raise RuntimeError(f"giving up after {MAX_ATTEMPTS} attempts")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download games from Lichess into a PGN file."
    )
    parser.add_argument("--user", default="Blitzscheck", help="Lichess username")
    parser.add_argument(
        "--max", type=int, default=300, help="maximum number of games to export"
    )
    parser.add_argument(
        "--perf-type",
        default="blitz",
        help="speed/variant filter, e.g. blitz, rapid, bullet "
        "(comma-separated; empty string means no filter)",
    )
    parser.add_argument(
        "--sort",
        default="dateDesc",
        choices=["dateDesc", "dateAsc"],
        help="export order",
    )
    parser.add_argument("--since", type=int, help="only games after this ms timestamp")
    parser.add_argument("--until", type=int, help="only games before this ms timestamp")
    parser.add_argument("--output", default="games.pgn", help="destination PGN file")
    parser.add_argument(
        "--token", help="Lichess API token (raises rate limits; optional)"
    )

    # The three flags below default to on because the analysis pipeline needs
    # every one of them: rated games only, clock comments, and opening names.
    parser.add_argument("--no-rated", dest="rated", action="store_false")
    parser.add_argument("--no-clocks", dest="clocks", action="store_false")
    parser.add_argument("--no-opening", dest="opening", action="store_false")
    parser.set_defaults(rated=True, clocks=True, opening=True)

    args = parser.parse_args()

    games = fetch(args)
    print(f"wrote {games} games to {args.output}", file=sys.stderr)
    if games == 0:
        print("warning: no games returned -- check username and filters", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
