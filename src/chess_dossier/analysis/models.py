from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from chess_dossier.domain.enums import ArtifactKind, ReportLanguage

MATE_SCORE_CP = 100_000


class PlayerSide(StrEnum):
    WHITE = "white"
    BLACK = "black"


class ErrorTag(StrEnum):
    STALEMATE = "stalemate"
    MATE = "mate"
    QUEEN_PIECE = "queen_piece"
    CONVERSION = "conversion"
    CHECK_TEMPO = "check_tempo"
    OTHER = "other"


class GamePhase(StrEnum):
    OPENING = "opening"
    MIDDLEGAME = "middlegame"
    LATE = "late"


@dataclass(frozen=True, slots=True)
class AnalysisConfig:
    fast_nodes: int = 12_000
    deep_nodes: int = 180_000
    candidate_loss_cp: int = 120
    conversion_trigger_cp: int = 200
    conversion_floor_cp: int = 50
    max_critical_positions: int = 64
    max_conversion_positions: int = 20
    max_training_positions: int = 64
    sustained_positions: int = 2
    thresholds_cp: tuple[int, ...] = (200, 300, 500)


@dataclass(frozen=True, slots=True)
class EngineIdentity:
    name: str
    author: str | None
    binary: str


@dataclass(frozen=True, slots=True)
class EngineEvaluation:
    score_cp: int
    mate_in: int | None
    best_move_uci: str
    pv_uci: tuple[str, ...]
    depth: int | None
    nodes: int | None


@dataclass(frozen=True, slots=True)
class GameSummary:
    game_key: str
    site: str
    date: str
    white: str
    black: str
    opponent: str
    side: PlayerSide
    result: str
    player_won: bool
    decisions: int
    confirmed_errors: int


@dataclass(frozen=True, slots=True)
class CriticalDecision:
    evidence_id: str
    game_key: str
    site: str
    date: str
    white: str
    black: str
    opponent: str
    side: PlayerSide
    phase: GamePhase
    move_number: int
    ply_index: int
    fen_before: str
    played_uci: str
    played_san: str
    best_uci: str
    best_san: str
    fast_best: EngineEvaluation
    fast_played: EngineEvaluation
    deep_best: EngineEvaluation
    deep_played: EngineEvaluation
    loss_cp: int
    tag: ErrorTag


@dataclass(frozen=True, slots=True)
class ConversionCase:
    evidence_id: str
    game_key: str
    site: str
    date: str
    white: str
    black: str
    opponent: str
    side: PlayerSide
    result: str
    fen: str
    start_move_number: int
    threshold_cp: int
    fast_score_cp: int
    deep_score_cp: int
    collapse_move_number: int | None
    collapse_played_san: str | None
    lowest_after_cp: int


@dataclass(frozen=True, slots=True)
class RateMetric:
    key: str
    numerator: int
    denominator: int

    @property
    def percentage(self) -> float:
        return 0.0 if self.denominator == 0 else self.numerator * 100 / self.denominator


@dataclass(frozen=True, slots=True)
class ThresholdMetric:
    threshold_cp: int
    reached_games: int
    fell_below_floor: int
    turned_negative: int
    not_won: int


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    schema_version: str
    generated_at: str
    source_sha256: str
    subject: str
    report_language: ReportLanguage
    engine: EngineIdentity
    config: AnalysisConfig
    games: tuple[GameSummary, ...]
    decisions_analyzed: int
    critical_decisions: tuple[CriticalDecision, ...]
    conversion_cases: tuple[ConversionCase, ...]
    phase_metrics: tuple[RateMetric, ...]
    tag_metrics: tuple[RateMetric, ...]
    threshold_metrics: tuple[ThresholdMetric, ...]
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class GeneratedFile:
    kind: ArtifactKind
    filename: str
    content: bytes


@dataclass(frozen=True, slots=True)
class GeneratedAnalysis:
    result: AnalysisResult
    files: tuple[GeneratedFile, ...]
