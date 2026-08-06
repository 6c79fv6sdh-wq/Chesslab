from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from urllib.parse import urlparse

import chess
import chess.pgn

from chess_dossier.analysis.errors import AnalysisError
from chess_dossier.analysis.models import PlayerSide
from chess_dossier.domain.enums import TimeControl


@dataclass(slots=True)
class ParsedGame:
    game: chess.pgn.Game
    game_key: str
    site: str
    date: str
    white: str
    black: str
    opponent: str
    player_color: chess.Color
    side: PlayerSide
    result: str


@dataclass(frozen=True, slots=True)
class ParsedCorpus:
    games: tuple[ParsedGame, ...]
    warnings: tuple[str, ...]


def decode_pgn(content: bytes) -> str:
    if not content.strip():
        raise AnalysisError("PGN corpus is empty")
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            return content.decode("cp1251")
        except UnicodeDecodeError as exc:
            raise AnalysisError("PGN must be UTF-8 or Windows-1251 text") from exc


def parse_corpus(
    content: bytes,
    *,
    player_name: str,
    max_games: int,
    time_control: TimeControl | None = None,
) -> ParsedCorpus:
    subject = player_name.strip().casefold()
    if not subject:
        raise AnalysisError("The player name used in PGN headers is required")

    stream = io.StringIO(decode_pgn(content))
    parsed: list[ParsedGame] = []
    warnings: list[str] = []
    seen: set[str] = set()
    input_count = 0
    while True:
        try:
            game = chess.pgn.read_game(stream)
        except (ValueError, IndexError) as exc:
            raise AnalysisError(f"PGN parser failed near game {input_count + 1}") from exc
        if game is None:
            break
        input_count += 1
        if input_count > max_games:
            raise AnalysisError(f"PGN contains more than the allowed {max_games} games")
        if game.errors:
            raise AnalysisError(f"Game {input_count} contains illegal or ambiguous moves")
        if not any(True for _ in game.mainline_moves()):
            warnings.append(f"Game {input_count} has no moves and was skipped")
            continue

        white = game.headers.get("White", "?").strip()
        black = game.headers.get("Black", "?").strip()
        if white.casefold() == subject:
            player_color = chess.WHITE
            opponent = black
            side = PlayerSide.WHITE
        elif black.casefold() == subject:
            player_color = chess.BLACK
            opponent = white
            side = PlayerSide.BLACK
        else:
            warnings.append(f"Game {input_count} does not contain {player_name!r} and was skipped")
            continue

        if time_control is not None and not _matches_time_control(game, time_control):
            warnings.append(
                f"Game {input_count} does not match {time_control.value} and was skipped"
            )
            continue

        key = _game_key(game)
        if key in seen:
            warnings.append(f"Duplicate game {key} was skipped")
            continue
        seen.add(key)
        parsed.append(
            ParsedGame(
                game=game,
                game_key=key,
                site=game.headers.get("Site", "?"),
                date=game.headers.get("Date", "????.??.??"),
                white=white,
                black=black,
                opponent=opponent,
                player_color=player_color,
                side=side,
                result=game.headers.get("Result", "*"),
            )
        )

    if not parsed:
        raise AnalysisError(f"No games for {player_name!r} were found in the PGN corpus")
    return ParsedCorpus(games=tuple(parsed), warnings=tuple(warnings))


def normalized_position_key(fen: str) -> str:
    return " ".join(fen.split()[:4])


def player_won(result: str, side: PlayerSide) -> bool:
    return (result == "1-0" and side == PlayerSide.WHITE) or (
        result == "0-1" and side == PlayerSide.BLACK
    )


def _game_key(game: chess.pgn.Game) -> str:
    site = game.headers.get("Site", "").strip()
    if site and site != "?":
        parsed = urlparse(site if "://" in site else f"https://placeholder/{site.lstrip('/')}")
        tail = parsed.path.rstrip("/").split("/")[-1]
        if tail:
            return tail
    moves = " ".join(move.uci() for move in game.mainline_moves())
    identity = "|".join(
        (
            game.headers.get("Date", ""),
            game.headers.get("White", ""),
            game.headers.get("Black", ""),
            moves,
        )
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]


def _matches_time_control(game: chess.pgn.Game, requested: TimeControl) -> bool:
    if requested == TimeControl.BOTH:
        return True
    event = game.headers.get("Event", "").casefold()
    if "bullet" in event:
        return requested == TimeControl.BLITZ
    if "blitz" in event:
        return requested == TimeControl.BLITZ
    if "rapid" in event:
        return requested == TimeControl.RAPID

    raw = game.headers.get("TimeControl", "").split(":", maxsplit=1)[0]
    base = raw.split("+", maxsplit=1)[0]
    if base.isdigit():
        seconds = int(base)
        if seconds < 600:
            return requested == TimeControl.BLITZ
        return requested == TimeControl.RAPID
    return True
