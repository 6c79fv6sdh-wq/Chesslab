from __future__ import annotations

import logging
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

import chess
import chess.engine

from chess_dossier.analysis.errors import EngineUnavailable
from chess_dossier.analysis.models import MATE_SCORE_CP, EngineEvaluation, EngineIdentity

logger = logging.getLogger(__name__)


class StockfishSession:
    def __init__(self, *, binary: Path, threads: int, hash_mb: int) -> None:
        self._binary = binary
        self._threads = threads
        self._hash_mb = hash_mb
        self._engine: chess.engine.SimpleEngine | None = None
        self._identity: EngineIdentity | None = None

    @property
    def identity(self) -> EngineIdentity:
        if self._identity is None:
            raise EngineUnavailable("Stockfish session has not been started")
        return self._identity

    def __enter__(self) -> StockfishSession:
        if not self._binary.is_file():
            raise EngineUnavailable(f"Stockfish binary does not exist: {self._binary}")
        engine: chess.engine.SimpleEngine | None = None
        try:
            engine = chess.engine.SimpleEngine.popen_uci(str(self._binary))
            engine.configure({"Threads": self._threads})
            engine.configure({"Hash": self._hash_mb})
        except (OSError, TimeoutError, chess.engine.EngineError) as exc:
            if engine is not None:
                with suppress(OSError, TimeoutError, chess.engine.EngineError):
                    engine.quit()
            raise EngineUnavailable(f"Cannot start Stockfish at {self._binary}") from exc
        self._engine = engine
        self._identity = EngineIdentity(
            name=engine.id.get("name", "Stockfish"),
            author=engine.id.get("author"),
            binary=self._binary.name,
        )
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._engine is not None:
            engine = self._engine
            self._engine = None
            try:
                engine.quit()
            except (OSError, TimeoutError, chess.engine.EngineError):
                logger.warning("Stockfish did not shut down cleanly", exc_info=True)

    def evaluate(
        self,
        board: chess.Board,
        *,
        player_color: chess.Color,
        nodes: int,
        root_move: chess.Move | None = None,
    ) -> EngineEvaluation:
        engine = self._require_engine()
        try:
            raw = engine.analyse(
                board,
                chess.engine.Limit(nodes=nodes),
                info=chess.engine.INFO_SCORE | chess.engine.INFO_PV,
                root_moves=[root_move] if root_move is not None else None,
            )
        except (OSError, TimeoutError, chess.engine.EngineError) as exc:
            raise EngineUnavailable("Stockfish failed while analysing a position") from exc
        info = raw
        pov_score = info.get("score")
        if pov_score is None:
            raise EngineUnavailable("Stockfish returned no score")
        score = pov_score.pov(player_color)
        score_cp = score.score(mate_score=MATE_SCORE_CP)
        if score_cp is None:
            raise EngineUnavailable("Stockfish returned an unusable score")
        pv = tuple(move.uci() for move in info.get("pv", []))
        if not pv and root_move is not None:
            pv = (root_move.uci(),)
        if not pv:
            raise EngineUnavailable("Stockfish returned no principal variation")
        depth = info.get("depth")
        searched_nodes = info.get("nodes")
        return EngineEvaluation(
            score_cp=score_cp,
            mate_in=score.mate(),
            best_move_uci=pv[0],
            pv_uci=pv,
            depth=depth if isinstance(depth, int) else None,
            nodes=searched_nodes if isinstance(searched_nodes, int) else None,
        )

    def clear_hash(self) -> None:
        engine = self._require_engine()
        try:
            engine.configure({"Clear Hash": None})
        except (chess.engine.EngineError, TypeError) as exc:
            raise EngineUnavailable("Stockfish hash could not be cleared") from exc

    def _require_engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            raise EngineUnavailable("Stockfish session is closed")
        return self._engine


@dataclass(frozen=True, slots=True)
class StockfishFactory:
    binary: Path
    threads: int = 1
    hash_mb: int = 128

    def __call__(self) -> StockfishSession:
        return StockfishSession(binary=self.binary, threads=self.threads, hash_mb=self.hash_mb)
