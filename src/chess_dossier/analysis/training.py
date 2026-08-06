from __future__ import annotations

import io
from collections.abc import Iterable

import chess
import chess.pgn

from chess_dossier.analysis.models import (
    AnalysisResult,
    ConversionCase,
    CriticalDecision,
    GeneratedFile,
    PlayerSide,
)
from chess_dossier.domain.enums import ArtifactKind, ReportLanguage


class PgnTrainingPackWriter:
    def build_files(self, result: AnalysisResult) -> tuple[GeneratedFile, ...]:
        errors = result.critical_decisions
        conversions = result.conversion_cases
        return (
            self._error_file(result, errors, PlayerSide.WHITE),
            self._error_file(result, errors, PlayerSide.BLACK),
            self._conversion_file(result, conversions, PlayerSide.WHITE),
            self._conversion_file(result, conversions, PlayerSide.BLACK),
        )

    def _error_file(
        self,
        result: AnalysisResult,
        decisions: Iterable[CriticalDecision],
        side: PlayerSide,
    ) -> GeneratedFile:
        selected = [item for item in decisions if item.side == side]
        games = [self._error_game(result, item, index) for index, item in enumerate(selected, 1)]
        if not games:
            games = [self._placeholder(result, side, "errors")]
        kind = (
            ArtifactKind.ERRORS_WHITE_PGN
            if side == PlayerSide.WHITE
            else ArtifactKind.ERRORS_BLACK_PGN
        )
        filename = f"errors_{side.value.upper()}.pgn"
        return GeneratedFile(kind=kind, filename=filename, content=_export_games(games))

    def _conversion_file(
        self,
        result: AnalysisResult,
        cases: Iterable[ConversionCase],
        side: PlayerSide,
    ) -> GeneratedFile:
        selected = [item for item in cases if item.side == side]
        games = [
            self._conversion_game(result, item, index) for index, item in enumerate(selected, 1)
        ]
        if not games:
            games = [self._placeholder(result, side, "conversion")]
        kind = (
            ArtifactKind.CONVERSION_WHITE_PGN
            if side == PlayerSide.WHITE
            else ArtifactKind.CONVERSION_BLACK_PGN
        )
        filename = f"conversion_{side.value.upper()}.pgn"
        return GeneratedFile(kind=kind, filename=filename, content=_export_games(games))

    def _error_game(
        self, result: AnalysisResult, item: CriticalDecision, index: int
    ) -> chess.pgn.Game:
        board = chess.Board(item.fen_before)
        game = chess.pgn.Game()
        game.setup(board)
        self._headers(
            game,
            result=result,
            event=_pick(result, "Чест-досье: ошибка", "Chess dossier: error"),
            site=item.site,
            date=item.date,
            round_name=_pick(
                result,
                f"Ошибка {index:02d} - {item.game_key}, ход {item.move_number}",
                f"Error {index:02d} - {item.game_key}, move {item.move_number}",
            ),
            white=item.white,
            black=item.black,
            side=item.side,
            fen=item.fen_before,
        )
        game.comment = _pick(
            result,
            (
                f"Задача: найдите надежное решение за {_side_text(item.side, russian=True)}. "
                f"В партии сыграно {item.played_san}; главный тег: {item.tag.value}. "
                f"Быстрый проход: {_score(item.fast_best)} -> {_score(item.fast_played)}. "
                f"Глубокая проверка: {_score(item.deep_best)} -> {_score(item.deep_played)}; "
                f"{_loss_text(item, russian=True)}. Лучший ход намеренно скрыт. "
                f"Evidence ID: {item.evidence_id}."
            ),
            (
                f"Task: find a reliable move for {_side_text(item.side, russian=False)}. "
                f"The game continued with {item.played_san}; primary tag: {item.tag.value}. "
                f"Fast pass: {_score(item.fast_best)} -> {_score(item.fast_played)}. "
                f"Deep recheck: {_score(item.deep_best)} -> {_score(item.deep_played)}; "
                f"{_loss_text(item, russian=False)}. The best move is intentionally hidden. "
                f"Evidence ID: {item.evidence_id}."
            ),
        )
        return game

    def _conversion_game(
        self, result: AnalysisResult, item: ConversionCase, index: int
    ) -> chess.pgn.Game:
        game = chess.pgn.Game()
        game.setup(chess.Board(item.fen))
        self._headers(
            game,
            result=result,
            event=_pick(result, "Чест-досье: реализация", "Chess dossier: conversion"),
            site=item.site,
            date=item.date,
            round_name=_pick(
                result,
                f"Конверсия {index:02d} - {item.game_key}, ход {item.start_move_number}",
                f"Conversion {index:02d} - {item.game_key}, move {item.start_move_number}",
            ),
            white=item.white,
            black=item.black,
            side=item.side,
            fen=item.fen,
        )
        collapse = (
            _pick(
                result,
                f"Перевес был сорван на ходу {item.collapse_move_number} после {item.collapse_played_san}.",
                f"The advantage collapsed on move {item.collapse_move_number} after {item.collapse_played_san}.",
            )
            if item.collapse_move_number is not None
            else _pick(
                result,
                "Партия не была выиграна, хотя порог был устойчиво достигнут.",
                "The game was not won despite reaching the threshold sustainably.",
            )
        )
        game.comment = _pick(
            result,
            (
                "Практическая цель: довести позицию до победы против бота. "
                f"Порог +{item.threshold_cp / 100:.0f}; быстрый проход "
                f"{item.fast_score_cp / 100:+.2f}, глубокая проверка "
                f"{item.deep_score_cp / 100:+.2f}. {collapse} "
                f"Минимум позднее: {item.lowest_after_cp / 100:+.2f}. "
                f"Решение и лучший ход намеренно не показаны. Evidence ID: {item.evidence_id}."
            ),
            (
                "Practical goal: convert the position against a bot. "
                f"Threshold +{item.threshold_cp / 100:.0f}; fast pass "
                f"{item.fast_score_cp / 100:+.2f}, deep recheck "
                f"{item.deep_score_cp / 100:+.2f}. {collapse} "
                f"Later minimum: {item.lowest_after_cp / 100:+.2f}. "
                f"The solution and best move are intentionally hidden. Evidence ID: {item.evidence_id}."
            ),
        )
        return game

    def _placeholder(
        self, result: AnalysisResult, side: PlayerSide, category: str
    ) -> chess.pgn.Game:
        game = chess.pgn.Game()
        game.headers["Event"] = _pick(
            result, "Чест-досье: пустой раздел", "Chess dossier: empty section"
        )
        game.headers["Site"] = "?"
        game.headers["Date"] = result.generated_at[:10].replace("-", ".")
        game.headers["Round"] = "0"
        game.headers["White"] = result.subject if side == PlayerSide.WHITE else "?"
        game.headers["Black"] = result.subject if side == PlayerSide.BLACK else "?"
        game.headers["Result"] = "*"
        game.headers["SetUp"] = "1"
        game.headers["FEN"] = chess.STARTING_FEN
        game.headers["Variant"] = "From Position"
        game.headers["Orientation"] = side.value
        game.headers["Annotator"] = result.engine.name
        game.comment = _pick(
            result,
            f"В категории {category} за {_side_text(side, russian=True)} нет подтвержденных позиций.",
            f"No confirmed {category} positions for {side.value}.",
        )
        return game

    @staticmethod
    def _headers(
        game: chess.pgn.Game,
        *,
        result: AnalysisResult,
        event: str,
        site: str,
        date: str,
        round_name: str,
        white: str,
        black: str,
        side: PlayerSide,
        fen: str,
    ) -> None:
        game.headers["Event"] = event
        game.headers["Site"] = site
        game.headers["Date"] = date
        game.headers["Round"] = round_name
        game.headers["White"] = white
        game.headers["Black"] = black
        game.headers["Result"] = "*"
        game.headers["SetUp"] = "1"
        game.headers["FEN"] = fen
        game.headers["Variant"] = "From Position"
        game.headers["Orientation"] = side.value
        game.headers["Annotator"] = (
            f"{result.engine.name}; fast {result.config.fast_nodes} nodes; "
            f"deep {result.config.deep_nodes} nodes"
        )


def _export_games(games: Iterable[chess.pgn.Game]) -> bytes:
    output = io.StringIO()
    exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
    for game in games:
        output.write(game.accept(exporter))
        output.write("\n\n")
    return output.getvalue().encode("utf-8")


def _score(evaluation: object) -> str:
    from chess_dossier.analysis.models import EngineEvaluation

    if not isinstance(evaluation, EngineEvaluation):
        raise TypeError("Invalid engine evaluation")
    if evaluation.mate_in is not None:
        return f"M{evaluation.mate_in:+d}"
    return f"{evaluation.score_cp / 100:+.2f}"


def _loss_text(item: CriticalDecision, *, russian: bool) -> str:
    if item.deep_best.mate_in is not None or item.deep_played.mate_in is not None:
        return "изменение матового статуса" if russian else "mate status changed"
    if russian:
        return f"потеря {item.loss_cp / 100:.2f} пешки"
    return f"loss {item.loss_cp / 100:.2f} pawns"


def _side_text(side: PlayerSide, *, russian: bool) -> str:
    if not russian:
        return side.value
    return "белых" if side == PlayerSide.WHITE else "черных"


def _pick(result: AnalysisResult, russian: str, english: str) -> str:
    return russian if result.report_language == ReportLanguage.RU else english
