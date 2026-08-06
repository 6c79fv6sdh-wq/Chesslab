import pytest

from chess_dossier.domain.enums import ArtifactKind
from chess_dossier.domain.errors import InvalidSource
from chess_dossier.infrastructure.pgn import PythonChessPgnInspector
from chess_dossier.presentation.telegram.artifacts import classify_artifact_filename


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("report.pdf", ArtifactKind.REPORT_PDF),
        ("errors_WHITE.pgn", ArtifactKind.ERRORS_WHITE_PGN),
        ("errors_BLACK.pgn", ArtifactKind.ERRORS_BLACK_PGN),
        ("conversion_WHITE.pgn", ArtifactKind.CONVERSION_WHITE_PGN),
        ("conversion_BLACK.pgn", ArtifactKind.CONVERSION_BLACK_PGN),
        ("plan_14d.pdf", ArtifactKind.PLAN_14D),
        ("analysis.json", ArtifactKind.ANALYSIS_JSON),
    ],
)
def test_artifact_classifier(filename: str, expected: ArtifactKind) -> None:
    assert classify_artifact_filename(filename) == expected


def test_pgn_inspector_counts_games(valid_pgn: bytes) -> None:
    result = PythonChessPgnInspector().inspect(valid_pgn, max_games=50)
    assert result.game_count == 1


def test_pgn_inspector_rejects_empty_file() -> None:
    with pytest.raises(InvalidSource):
        PythonChessPgnInspector().inspect(b"", max_games=50)


def test_pgn_inspector_rejects_illegal_moves() -> None:
    content = b"""[White \"A\"]
[Black \"B\"]
[Result \"*\"]

1. e4 e5 2. Ke3 *
"""
    with pytest.raises(InvalidSource, match="illegal or ambiguous"):
        PythonChessPgnInspector().inspect(content, max_games=50)
