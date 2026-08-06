from __future__ import annotations

import io
import logging

import chess.pgn

from chess_dossier.application.dto import PgnInspection
from chess_dossier.domain.errors import InvalidSource

logger = logging.getLogger(__name__)


class PythonChessPgnInspector:
    def inspect(
        self,
        content: bytes,
        *,
        max_games: int,
        required_player: str | None = None,
        allow_position_tasks: bool = False,
        expected_orientation: str | None = None,
    ) -> PgnInspection:
        if not content.strip():
            raise InvalidSource("PGN file is empty")
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            try:
                text = content.decode("cp1251")
            except UnicodeDecodeError as exc:
                raise InvalidSource("PGN must be UTF-8 or Windows-1251 text") from exc

        stream = io.StringIO(text)
        game_count = 0
        matching_game_count = 0
        games_with_moves = 0
        warnings: list[str] = []
        normalized_player = required_player.strip().casefold() if required_player else None
        while True:
            try:
                game = chess.pgn.read_game(stream)
            except (ValueError, IndexError) as exc:
                raise InvalidSource(
                    f"PGN parser rejected the file near game {game_count + 1}"
                ) from exc
            if game is None:
                break
            game_count += 1
            if game_count > max_games:
                raise InvalidSource(f"PGN contains more than the allowed {max_games} games")
            if game.errors:
                raise InvalidSource(
                    f"Game {game_count} contains {len(game.errors)} illegal or ambiguous move(s)"
                )
            has_moves = any(True for _ in game.mainline_moves())
            if has_moves:
                games_with_moves += 1
            else:
                warnings.append(f"Game {game_count}: no moves")
                if allow_position_tasks:
                    if game.headers.get("SetUp") != "1" or not game.headers.get("FEN"):
                        raise InvalidSource(
                            f"Game {game_count} must contain SetUp=1 and FEN for a position task"
                        )
                    try:
                        board = game.board()
                    except ValueError as exc:
                        raise InvalidSource(f"Game {game_count} has an invalid FEN") from exc
                    if not board.is_valid():
                        raise InvalidSource(f"Game {game_count} has an invalid start position")
            if expected_orientation and (
                game.headers.get("Orientation", "").strip().casefold()
                != expected_orientation.casefold()
            ):
                raise InvalidSource(
                    f"Game {game_count} must have Orientation={expected_orientation}"
                )
            if normalized_player and normalized_player in {
                game.headers.get("White", "").strip().casefold(),
                game.headers.get("Black", "").strip().casefold(),
            }:
                matching_game_count += 1

        if game_count == 0:
            raise InvalidSource("No chess games were found in the PGN")
        if games_with_moves == 0 and not allow_position_tasks:
            raise InvalidSource("PGN contains headers but no moves")
        if normalized_player and matching_game_count == 0:
            raise InvalidSource(f"Player {required_player!r} was not found in PGN headers")
        logger.info("pgn_validated", extra={"game_count": game_count, "warnings": len(warnings)})
        return PgnInspection(
            game_count=game_count,
            warnings=tuple(warnings),
            matching_game_count=matching_game_count if normalized_player else None,
        )
