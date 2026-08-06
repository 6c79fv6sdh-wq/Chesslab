from __future__ import annotations

import io
import json
from pathlib import Path
from types import TracebackType

import chess
import chess.pgn
from pypdf import PdfReader

from chess_dossier.analysis.models import (
    AnalysisConfig,
    EngineEvaluation,
    EngineIdentity,
)
from chess_dossier.analysis.pgn import parse_corpus
from chess_dossier.analysis.report import PdfReportRenderer
from chess_dossier.analysis.service import AnalysisPipeline
from chess_dossier.analysis.training import PgnTrainingPackWriter
from chess_dossier.domain.enums import ArtifactKind, ReportLanguage, TimeControl
from chess_dossier.infrastructure.pgn import PythonChessPgnInspector


class FakeEngineSession:
    def __init__(self) -> None:
        self.clear_calls = 0

    @property
    def identity(self) -> EngineIdentity:
        return EngineIdentity(name="FakeFish 1", author="tests", binary="fake")

    def __enter__(self) -> FakeEngineSession:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None

    def clear_hash(self) -> None:
        self.clear_calls += 1

    def evaluate(
        self,
        board: chess.Board,
        *,
        player_color: chess.Color,
        nodes: int,
        root_move: chess.Move | None = None,
    ) -> EngineEvaluation:
        del player_color
        best = sorted(board.legal_moves, key=lambda move: move.uci())[0]
        selected = root_move or best
        score = 350 if selected == best else -100
        pv = [selected]
        after = board.copy(stack=False)
        after.push(selected)
        if not after.is_game_over():
            pv.append(sorted(after.legal_moves, key=lambda move: move.uci())[0])
        return EngineEvaluation(
            score_cp=score,
            mate_in=None,
            best_move_uci=selected.uci(),
            pv_uci=tuple(move.uci() for move in pv),
            depth=12 if nodes < 100 else 20,
            nodes=nodes,
        )


class FakeEngineFactory:
    def __init__(self) -> None:
        self.session = FakeEngineSession()

    def __call__(self) -> FakeEngineSession:
        return self.session


class ScriptedMateSession:
    """Reports a fixed verdict for the best move and for the move actually played."""

    def __init__(self, *, best: tuple[int, int | None], played: tuple[int, int | None]) -> None:
        self._best = best
        self._played = played

    @property
    def identity(self) -> EngineIdentity:
        return EngineIdentity(name="ScriptedFish", author="tests", binary="fake")

    def __enter__(self) -> ScriptedMateSession:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None

    def clear_hash(self) -> None:
        return None

    def evaluate(
        self,
        board: chess.Board,
        *,
        player_color: chess.Color,
        nodes: int,
        root_move: chess.Move | None = None,
    ) -> EngineEvaluation:
        del board, player_color, nodes
        score_cp, mate_in = self._played if root_move is not None else self._best
        move_uci = root_move.uci() if root_move is not None else "d2d4"
        return EngineEvaluation(
            score_cp=score_cp,
            mate_in=mate_in,
            best_move_uci=move_uci,
            pv_uci=(move_uci,),
            depth=20,
            nodes=1_000,
        )


class ScriptedMateFactory:
    def __init__(self, session: ScriptedMateSession) -> None:
        self._session = session

    def __call__(self) -> ScriptedMateSession:
        return self._session


MATE_PGN = b"""[Event "Test"]
[Site "Local"]
[Date "2026.08.06"]
[Round "1"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0
"""


def _mate_case(best: tuple[int, int | None], played: tuple[int, int | None]) -> tuple[int, str]:
    pipeline = AnalysisPipeline(
        engine_factory=ScriptedMateFactory(ScriptedMateSession(best=best, played=played)),
        report_renderer=PdfReportRenderer(),
        training_writer=PgnTrainingPackWriter(),
        config=AnalysisConfig(fast_nodes=50, deep_nodes=200, candidate_loss_cp=120),
    )
    result = pipeline.run(
        pgn_content=MATE_PGN,
        player_name="A",
        report_language=ReportLanguage.RU,
        max_games=10,
    ).result
    confirmed = result.critical_decisions
    return len(confirmed), confirmed[0].tag.value if confirmed else ""


def test_slower_forced_mate_is_not_reported_as_an_error() -> None:
    # Mate in 8 instead of mate in 2 still mates; the client must not be told
    # they missed a mate when the move they played wins by force.
    count, _ = _mate_case(best=(99_998, 2), played=(99_992, 8))
    assert count == 0


def test_missed_forced_mate_is_reported() -> None:
    count, tag = _mate_case(best=(99_998, 2), played=(400, None))
    assert count == 1
    assert tag == "mate"


def test_allowing_a_mate_is_reported() -> None:
    count, tag = _mate_case(best=(120, None), played=(-99_999, -1))
    assert count == 1
    assert tag == "mate"


def test_parser_filters_player_and_deduplicates(valid_pgn: bytes) -> None:
    duplicate = valid_pgn.replace(b'[Event "Test"]', b'[Event "Rapid Test"]')
    unrelated = valid_pgn.replace(b'[White "A"]', b'[White "C"]')
    corpus = parse_corpus(
        valid_pgn + b"\n" + duplicate + b"\n" + unrelated,
        player_name="A",
        max_games=10,
        time_control=TimeControl.BOTH,
    )
    assert len(corpus.games) == 1
    assert corpus.games[0].side.value == "white"
    assert any("Duplicate" in warning for warning in corpus.warnings)
    assert any("does not contain" in warning for warning in corpus.warnings)


def test_pipeline_generates_stable_complete_bundle(valid_pgn: bytes, tmp_path: Path) -> None:
    engine_factory = FakeEngineFactory()
    pipeline = AnalysisPipeline(
        engine_factory=engine_factory,
        report_renderer=PdfReportRenderer(),
        training_writer=PgnTrainingPackWriter(),
        config=AnalysisConfig(
            fast_nodes=50,
            deep_nodes=200,
            candidate_loss_cp=120,
            max_critical_positions=8,
            max_conversion_positions=4,
            max_training_positions=8,
        ),
    )
    generated = pipeline.run(
        pgn_content=valid_pgn,
        player_name="A",
        report_language=ReportLanguage.RU,
        max_games=50,
        time_control=TimeControl.BOTH,
    )
    by_kind = {item.kind: item for item in generated.files}
    assert set(by_kind) == {
        ArtifactKind.ANALYSIS_JSON,
        ArtifactKind.REPORT_PDF,
        ArtifactKind.ERRORS_WHITE_PGN,
        ArtifactKind.ERRORS_BLACK_PGN,
        ArtifactKind.CONVERSION_WHITE_PGN,
        ArtifactKind.CONVERSION_BLACK_PGN,
    }
    assert generated.result.decisions_analyzed == 3
    assert generated.result.critical_decisions
    assert generated.result.conversion_cases
    assert engine_factory.session.clear_calls >= generated.result.decisions_analyzed * 2

    manifest = json.loads(by_kind[ArtifactKind.ANALYSIS_JSON].content)
    assert manifest["schema_version"] == "1.0"
    assert manifest["subject"] == "A"

    pdf = by_kind[ArtifactKind.REPORT_PDF].content
    assert pdf.startswith(b"%PDF-")
    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) >= 4
    assert "ШАХМАТНОЕ ДОСЬЕ" in (reader.pages[0].extract_text() or "")

    inspector = PythonChessPgnInspector()
    for kind, orientation in (
        (ArtifactKind.ERRORS_WHITE_PGN, "white"),
        (ArtifactKind.ERRORS_BLACK_PGN, "black"),
        (ArtifactKind.CONVERSION_WHITE_PGN, "white"),
        (ArtifactKind.CONVERSION_BLACK_PGN, "black"),
    ):
        content = by_kind[kind].content
        inspection = inspector.inspect(
            content,
            max_games=64,
            allow_position_tasks=True,
            expected_orientation=orientation,
        )
        assert inspection.game_count >= 1
        game = chess.pgn.read_game(io.StringIO(content.decode("utf-8")))
        assert game is not None
        assert game.headers["Orientation"] == orientation

    output = tmp_path / "report.pdf"
    output.write_bytes(pdf)
    assert output.stat().st_size > 5_000
