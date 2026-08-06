"""Compatibility exports for the implemented local analysis pipeline."""

from chess_dossier.analysis.models import AnalysisConfig, AnalysisResult, GeneratedAnalysis
from chess_dossier.analysis.service import AnalysisPipeline
from chess_dossier.infrastructure.analysis.stockfish import StockfishFactory

__all__ = [
    "AnalysisConfig",
    "AnalysisPipeline",
    "AnalysisResult",
    "GeneratedAnalysis",
    "StockfishFactory",
]
