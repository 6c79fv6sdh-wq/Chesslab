from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

from chess_dossier.analysis.models import AnalysisConfig
from chess_dossier.analysis.report import PdfReportRenderer
from chess_dossier.analysis.service import AnalysisPipeline
from chess_dossier.analysis.training import PgnTrainingPackWriter
from chess_dossier.domain.enums import ReportLanguage, TimeControl
from chess_dossier.infrastructure.analysis.stockfish import StockfishFactory


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="chess-dossier-analyze",
        description="Generate a verified chess dossier from a local PGN corpus.",
    )
    parser.add_argument("--pgn", type=Path, required=True, help="Input PGN file")
    parser.add_argument("--player", required=True, help="Exact White/Black header value")
    parser.add_argument("--output", type=Path, required=True, help="Output directory")
    parser.add_argument(
        "--stockfish",
        type=Path,
        default=Path(os.environ.get("STOCKFISH_PATH", "/usr/games/stockfish")),
    )
    parser.add_argument("--language", choices=("ru", "en"), default="ru")
    parser.add_argument("--time-control", choices=("blitz", "rapid", "both"), default="both")
    parser.add_argument("--max-games", type=int, default=50)
    parser.add_argument("--fast-nodes", type=int, default=12_000)
    parser.add_argument("--deep-nodes", type=int, default=180_000)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--hash-mb", type=int, default=128)
    parser.add_argument("--brand", default="Чест-досье")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.fast_nodes <= 0 or args.deep_nodes <= args.fast_nodes:
        raise SystemExit("--deep-nodes must be greater than positive --fast-nodes")
    if not 1 <= args.max_games <= 500:
        raise SystemExit("--max-games must be between 1 and 500")
    pipeline = AnalysisPipeline(
        engine_factory=StockfishFactory(
            binary=args.stockfish,
            threads=args.threads,
            hash_mb=args.hash_mb,
        ),
        report_renderer=PdfReportRenderer(brand_name=args.brand),
        training_writer=PgnTrainingPackWriter(),
        config=AnalysisConfig(fast_nodes=args.fast_nodes, deep_nodes=args.deep_nodes),
    )
    generated = pipeline.run(
        pgn_content=args.pgn.read_bytes(),
        player_name=args.player,
        report_language=ReportLanguage(args.language),
        max_games=args.max_games,
        time_control=TimeControl(args.time_control),
    )
    args.output.mkdir(parents=True, exist_ok=True)
    for item in generated.files:
        _atomic_write(args.output / item.filename, item.content)
    print(
        f"Generated {len(generated.files)} files from {len(generated.result.games)} games; "
        f"{len(generated.result.critical_decisions)} critical positions confirmed."
    )
    return 0


def _atomic_write(destination: Path, content: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, destination)
    finally:
        Path(temporary_name).unlink(missing_ok=True)


def run() -> None:
    raise SystemExit(main())


if __name__ == "__main__":
    run()
