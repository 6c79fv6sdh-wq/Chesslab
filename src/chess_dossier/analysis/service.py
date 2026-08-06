from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime

import chess

from chess_dossier.analysis.models import (
    AnalysisConfig,
    AnalysisResult,
    ConversionCase,
    CriticalDecision,
    EngineEvaluation,
    EngineIdentity,
    ErrorTag,
    GamePhase,
    GameSummary,
    GeneratedAnalysis,
    GeneratedFile,
    RateMetric,
    ThresholdMetric,
)
from chess_dossier.analysis.pgn import (
    ParsedCorpus,
    ParsedGame,
    normalized_position_key,
    parse_corpus,
    player_won,
)
from chess_dossier.analysis.ports import (
    EngineFactory,
    EngineSession,
    ReportRenderer,
    TrainingPackWriter,
)
from chess_dossier.analysis.serialization import result_to_json
from chess_dossier.domain.enums import ArtifactKind, ReportLanguage, TimeControl


@dataclass(slots=True)
class _Decision:
    parsed: ParsedGame
    board: chess.Board
    move: chess.Move
    move_number: int
    ply_index: int
    played_san: str
    phase: GamePhase
    fast_best: EngineEvaluation
    fast_played: EngineEvaluation

    @property
    def loss_cp(self) -> int:
        return max(0, self.fast_best.score_cp - self.fast_played.score_cp)


@dataclass(slots=True)
class _GamePass:
    parsed: ParsedGame
    decisions: list[_Decision]


class AnalysisPipeline:
    def __init__(
        self,
        *,
        engine_factory: EngineFactory,
        report_renderer: ReportRenderer,
        training_writer: TrainingPackWriter,
        config: AnalysisConfig,
    ) -> None:
        self._engine_factory = engine_factory
        self._report_renderer = report_renderer
        self._training_writer = training_writer
        self._config = config

    def run(
        self,
        *,
        pgn_content: bytes,
        player_name: str,
        report_language: ReportLanguage,
        max_games: int,
        time_control: TimeControl | None = None,
        generated_at: datetime | None = None,
    ) -> GeneratedAnalysis:
        corpus = parse_corpus(
            pgn_content,
            player_name=player_name,
            max_games=max_games,
            time_control=time_control,
        )
        source_sha256 = hashlib.sha256(pgn_content).hexdigest()
        with self._engine_factory() as engine:
            passes = [self._fast_game(engine, parsed) for parsed in corpus.games]
            candidates = self._select_candidates(passes)
            engine.clear_hash()
            confirmed: list[CriticalDecision] = []
            for candidate in candidates:
                item = self._deep_confirm(engine, candidate)
                if item is not None:
                    confirmed.append(item)
            critical = tuple(confirmed)
            conversions, threshold_metrics = self._conversion_analysis(engine, passes)
            result = self._build_result(
                corpus=corpus,
                passes=passes,
                critical=critical,
                conversions=conversions,
                threshold_metrics=threshold_metrics,
                source_sha256=source_sha256,
                subject=player_name.strip(),
                report_language=report_language,
                generated_at=generated_at or datetime.now(UTC),
                engine_identity=engine.identity,
            )

        json_file = GeneratedFile(
            kind=ArtifactKind.ANALYSIS_JSON,
            filename="analysis.json",
            content=result_to_json(result),
        )
        pdf_file = GeneratedFile(
            kind=ArtifactKind.REPORT_PDF,
            filename="report.pdf",
            content=self._report_renderer.render(result),
        )
        files = (json_file, pdf_file, *self._training_writer.build_files(result))
        return GeneratedAnalysis(result=result, files=files)

    def _fast_game(self, session: EngineSession, parsed: ParsedGame) -> _GamePass:
        decisions: list[_Decision] = []
        board = parsed.game.board()
        for ply_index, move in enumerate(parsed.game.mainline_moves()):
            if board.turn == parsed.player_color:
                snapshot = board.copy(stack=True)
                played_san = board.san(move)
                session.clear_hash()
                best = session.evaluate(
                    snapshot,
                    player_color=parsed.player_color,
                    nodes=self._config.fast_nodes,
                )
                played = (
                    best
                    if best.best_move_uci == move.uci()
                    else self._evaluate_played(
                        session,
                        snapshot,
                        player_color=parsed.player_color,
                        nodes=self._config.fast_nodes,
                        move=move,
                    )
                )
                decisions.append(
                    _Decision(
                        parsed=parsed,
                        board=snapshot,
                        move=move,
                        move_number=board.fullmove_number,
                        ply_index=ply_index,
                        played_san=played_san,
                        phase=_phase(board.fullmove_number),
                        fast_best=best,
                        fast_played=played,
                    )
                )
            board.push(move)
        return _GamePass(parsed=parsed, decisions=decisions)

    def _select_candidates(self, passes: list[_GamePass]) -> list[_Decision]:
        deduplicated: dict[str, _Decision] = {}
        for game_pass in passes:
            for decision in game_pass.decisions:
                if not self._is_candidate(decision):
                    continue
                key = normalized_position_key(decision.board.fen())
                current = deduplicated.get(key)
                if current is None or decision.loss_cp > current.loss_cp:
                    deduplicated[key] = decision
        ranked = sorted(
            deduplicated.values(),
            key=lambda item: (item.loss_cp, abs(item.fast_best.score_cp)),
            reverse=True,
        )
        return ranked[: self._config.max_critical_positions]

    def _is_candidate(self, decision: _Decision) -> bool:
        board_after = decision.board.copy(stack=False)
        board_after.push(decision.move)
        missed_mate = _forces_mate(decision.fast_best) and not _forces_mate(decision.fast_played)
        allowed_mate = _allows_mate(decision.fast_played)
        conversion = (
            decision.fast_best.score_cp >= self._config.conversion_trigger_cp
            and decision.fast_played.score_cp < self._config.conversion_floor_cp
        )
        return (
            decision.loss_cp >= self._config.candidate_loss_cp
            or missed_mate
            or allowed_mate
            or board_after.is_stalemate()
            or conversion
        )

    def _deep_confirm(self, session: EngineSession, decision: _Decision) -> CriticalDecision | None:
        session.clear_hash()
        best = session.evaluate(
            decision.board,
            player_color=decision.parsed.player_color,
            nodes=self._config.deep_nodes,
        )
        played = (
            best
            if best.best_move_uci == decision.move.uci()
            else self._evaluate_played(
                session,
                decision.board,
                player_color=decision.parsed.player_color,
                nodes=self._config.deep_nodes,
                move=decision.move,
            )
        )
        loss_cp = max(0, best.score_cp - played.score_cp)
        tag = self._classify(decision, best, played)
        special = tag in {ErrorTag.STALEMATE, ErrorTag.MATE, ErrorTag.CONVERSION}
        if loss_cp < self._config.candidate_loss_cp and not special:
            return None
        best_move = chess.Move.from_uci(best.best_move_uci)
        best_san = decision.board.san(best_move)
        evidence_id = _evidence_id(
            decision.parsed.game_key, decision.ply_index, decision.board.fen(), decision.move.uci()
        )
        return CriticalDecision(
            evidence_id=evidence_id,
            game_key=decision.parsed.game_key,
            site=decision.parsed.site,
            date=decision.parsed.date,
            white=decision.parsed.white,
            black=decision.parsed.black,
            opponent=decision.parsed.opponent,
            side=decision.parsed.side,
            phase=decision.phase,
            move_number=decision.move_number,
            ply_index=decision.ply_index,
            fen_before=decision.board.fen(),
            played_uci=decision.move.uci(),
            played_san=decision.played_san,
            best_uci=best.best_move_uci,
            best_san=best_san,
            fast_best=decision.fast_best,
            fast_played=decision.fast_played,
            deep_best=best,
            deep_played=played,
            loss_cp=loss_cp,
            tag=tag,
        )

    def _classify(
        self, decision: _Decision, best: EngineEvaluation, played: EngineEvaluation
    ) -> ErrorTag:
        board_after = decision.board.copy(stack=False)
        board_after.push(decision.move)
        if board_after.is_stalemate() and best.score_cp >= self._config.conversion_trigger_cp:
            return ErrorTag.STALEMATE
        if (_forces_mate(best) and not _forces_mate(played)) or _allows_mate(played):
            return ErrorTag.MATE

        reply = _reply_after_played(played, decision.move)
        if reply is not None and reply in board_after.legal_moves:
            captured = board_after.piece_at(reply.to_square)
            if (
                captured is not None
                and captured.color == decision.parsed.player_color
                and captured.piece_type != chess.PAWN
            ):
                return ErrorTag.QUEEN_PIECE

        if (
            best.score_cp >= self._config.conversion_trigger_cp
            and played.score_cp < self._config.conversion_floor_cp
        ):
            return ErrorTag.CONVERSION
        if reply is not None and reply in board_after.legal_moves:
            reply_board = board_after.copy(stack=False)
            reply_board.push(reply)
            if reply_board.is_check():
                return ErrorTag.CHECK_TEMPO
        return ErrorTag.OTHER

    def _conversion_analysis(
        self, session: EngineSession, passes: list[_GamePass]
    ) -> tuple[tuple[ConversionCase, ...], tuple[ThresholdMetric, ...]]:
        metrics: list[ThresholdMetric] = []
        cases: list[tuple[int, _Decision, int, int | None, str | None]] = []
        for threshold in self._config.thresholds_cp:
            reached = fell = negative = not_won_count = 0
            for game_pass in passes:
                start_index = _sustained_start(
                    game_pass.decisions,
                    threshold=threshold,
                    required=self._config.sustained_positions,
                )
                if start_index is None:
                    continue
                reached += 1
                tail = game_pass.decisions[start_index:]
                lowest = min(item.fast_played.score_cp for item in tail)
                collapse = next(
                    (
                        item
                        for item in tail
                        if item.fast_played.score_cp < self._config.conversion_floor_cp
                    ),
                    None,
                )
                if lowest < self._config.conversion_floor_cp:
                    fell += 1
                if lowest < 0:
                    negative += 1
                won = player_won(game_pass.parsed.result, game_pass.parsed.side)
                if not won:
                    not_won_count += 1
                if collapse is not None or not won:
                    start = game_pass.decisions[start_index]
                    cases.append(
                        (
                            threshold,
                            start,
                            lowest,
                            collapse.move_number if collapse else None,
                            collapse.played_san if collapse else None,
                        )
                    )
            metrics.append(
                ThresholdMetric(
                    threshold_cp=threshold,
                    reached_games=reached,
                    fell_below_floor=fell,
                    turned_negative=negative,
                    not_won=not_won_count,
                )
            )

        highest_per_game: dict[str, tuple[int, _Decision, int, int | None, str | None]] = {}
        for item in cases:
            threshold, start, *_ = item
            current = highest_per_game.get(start.parsed.game_key)
            if current is None or threshold > current[0]:
                highest_per_game[start.parsed.game_key] = item
        selected = sorted(
            highest_per_game.values(), key=lambda item: (item[0], -item[2]), reverse=True
        )[: self._config.max_conversion_positions]

        output: list[ConversionCase] = []
        seen: set[str] = set()
        for threshold, start, lowest, collapse_move, collapse_san in selected:
            key = normalized_position_key(start.board.fen())
            if key in seen:
                continue
            seen.add(key)
            session.clear_hash()
            deep = session.evaluate(
                start.board,
                player_color=start.parsed.player_color,
                nodes=self._config.deep_nodes,
            )
            if deep.score_cp < self._config.conversion_trigger_cp:
                continue
            output.append(
                ConversionCase(
                    evidence_id=_evidence_id(
                        start.parsed.game_key,
                        start.ply_index,
                        start.board.fen(),
                        f"conversion-{threshold}",
                    ),
                    game_key=start.parsed.game_key,
                    site=start.parsed.site,
                    date=start.parsed.date,
                    white=start.parsed.white,
                    black=start.parsed.black,
                    opponent=start.parsed.opponent,
                    side=start.parsed.side,
                    result=start.parsed.result,
                    fen=start.board.fen(),
                    start_move_number=start.move_number,
                    threshold_cp=threshold,
                    fast_score_cp=start.fast_best.score_cp,
                    deep_score_cp=deep.score_cp,
                    collapse_move_number=collapse_move,
                    collapse_played_san=collapse_san,
                    lowest_after_cp=lowest,
                )
            )
        return tuple(output), tuple(metrics)

    @staticmethod
    def _evaluate_played(
        session: EngineSession,
        board: chess.Board,
        *,
        player_color: chess.Color,
        nodes: int,
        move: chess.Move,
    ) -> EngineEvaluation:
        session.clear_hash()
        return session.evaluate(
            board,
            player_color=player_color,
            nodes=nodes,
            root_move=move,
        )

    def _build_result(
        self,
        *,
        corpus: ParsedCorpus,
        passes: list[_GamePass],
        critical: tuple[CriticalDecision, ...],
        conversions: tuple[ConversionCase, ...],
        threshold_metrics: tuple[ThresholdMetric, ...],
        source_sha256: str,
        subject: str,
        report_language: ReportLanguage,
        generated_at: datetime,
        engine_identity: EngineIdentity,
    ) -> AnalysisResult:
        errors_by_game = Counter(item.game_key for item in critical)
        summaries = tuple(
            GameSummary(
                game_key=item.parsed.game_key,
                site=item.parsed.site,
                date=item.parsed.date,
                white=item.parsed.white,
                black=item.parsed.black,
                opponent=item.parsed.opponent,
                side=item.parsed.side,
                result=item.parsed.result,
                player_won=player_won(item.parsed.result, item.parsed.side),
                decisions=len(item.decisions),
                confirmed_errors=errors_by_game[item.parsed.game_key],
            )
            for item in passes
        )
        phase_denominator = Counter(
            decision.phase for item in passes for decision in item.decisions
        )
        phase_numerator = Counter(item.phase for item in critical)
        phase_metrics = tuple(
            RateMetric(
                key=phase.value,
                numerator=phase_numerator[phase],
                denominator=phase_denominator[phase],
            )
            for phase in GamePhase
        )
        tag_counts = Counter(item.tag for item in critical)
        tag_metrics = tuple(
            RateMetric(key=tag.value, numerator=tag_counts[tag], denominator=len(critical))
            for tag in ErrorTag
        )
        return AnalysisResult(
            schema_version="1.0",
            generated_at=generated_at.astimezone(UTC).isoformat(),
            source_sha256=source_sha256,
            subject=subject,
            report_language=report_language,
            engine=engine_identity,
            config=self._config,
            games=summaries,
            decisions_analyzed=sum(len(item.decisions) for item in passes),
            critical_decisions=tuple(
                sorted(critical, key=lambda item: item.loss_cp, reverse=True)[
                    : self._config.max_training_positions
                ]
            ),
            conversion_cases=conversions,
            phase_metrics=phase_metrics,
            tag_metrics=tag_metrics,
            threshold_metrics=threshold_metrics,
            warnings=corpus.warnings,
        )


def _forces_mate(evaluation: EngineEvaluation) -> bool:
    return evaluation.mate_in is not None and evaluation.mate_in > 0


def _allows_mate(evaluation: EngineEvaluation) -> bool:
    return evaluation.mate_in is not None and evaluation.mate_in < 0


def _phase(move_number: int) -> GamePhase:
    if move_number <= 10:
        return GamePhase.OPENING
    if move_number <= 25:
        return GamePhase.MIDDLEGAME
    return GamePhase.LATE


def _reply_after_played(evaluation: EngineEvaluation, played_move: chess.Move) -> chess.Move | None:
    if len(evaluation.pv_uci) < 2 or evaluation.pv_uci[0] != played_move.uci():
        return None
    try:
        return chess.Move.from_uci(evaluation.pv_uci[1])
    except ValueError:
        return None


def _sustained_start(decisions: list[_Decision], *, threshold: int, required: int) -> int | None:
    if required <= 0:
        raise ValueError("required must be positive")
    for index in range(0, len(decisions) - required + 1):
        window = decisions[index : index + required]
        if all(item.fast_best.score_cp >= threshold for item in window):
            return index
    return None


def _evidence_id(game_key: str, ply_index: int, fen: str, discriminator: str) -> str:
    raw = f"{game_key}|{ply_index}|{normalized_position_key(fen)}|{discriminator}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
