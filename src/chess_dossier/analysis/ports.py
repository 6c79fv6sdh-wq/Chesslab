from __future__ import annotations

from types import TracebackType
from typing import Protocol

import chess

from chess_dossier.analysis.models import (
    AnalysisResult,
    EngineEvaluation,
    EngineIdentity,
    GeneratedFile,
    PlayerSide,
)


class EngineSession(Protocol):
    @property
    def identity(self) -> EngineIdentity: ...

    def evaluate(
        self,
        board: chess.Board,
        *,
        player_color: chess.Color,
        nodes: int,
        root_move: chess.Move | None = None,
    ) -> EngineEvaluation: ...

    def clear_hash(self) -> None: ...

    def __enter__(self) -> EngineSession: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None: ...


class EngineFactory(Protocol):
    def __call__(self) -> EngineSession: ...


class ReportRenderer(Protocol):
    def render(self, result: AnalysisResult) -> bytes: ...


class TrainingPackWriter(Protocol):
    def build_files(self, result: AnalysisResult) -> tuple[GeneratedFile, ...]: ...


class PositionKey(Protocol):
    side: PlayerSide
    fen: str
