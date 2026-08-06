from __future__ import annotations

from chess_dossier.domain.enums import ArtifactKind

ARTIFACT_DELIVERY_RANK: dict[ArtifactKind, int] = {
    ArtifactKind.REPORT_PDF: 0,
    ArtifactKind.ERRORS_WHITE_PGN: 1,
    ArtifactKind.ERRORS_BLACK_PGN: 2,
    ArtifactKind.CONVERSION_WHITE_PGN: 3,
    ArtifactKind.CONVERSION_BLACK_PGN: 4,
    ArtifactKind.PLAN_14D: 5,
    ArtifactKind.ANALYSIS_JSON: 6,
    ArtifactKind.SUPPLEMENT: 7,
}


def classify_artifact_filename(filename: str) -> ArtifactKind:
    lowered = filename.lower().replace("-", "_").replace(" ", "_")
    if lowered == "analysis.json" or lowered.endswith("_analysis.json"):
        return ArtifactKind.ANALYSIS_JSON
    if lowered.endswith(".pdf"):
        if "plan" in lowered or "14" in lowered:
            return ArtifactKind.PLAN_14D
        return ArtifactKind.REPORT_PDF
    if not lowered.endswith(".pgn"):
        return ArtifactKind.SUPPLEMENT

    is_white = any(token in lowered for token in ("white", "bel", "бел"))
    is_black = any(token in lowered for token in ("black", "chern", "черн"))
    is_error = any(token in lowered for token in ("error", "mistake", "oshib", "ошиб"))
    is_conversion = any(token in lowered for token in ("conversion", "realiz", "реализ", "convert"))
    if is_error and is_white:
        return ArtifactKind.ERRORS_WHITE_PGN
    if is_error and is_black:
        return ArtifactKind.ERRORS_BLACK_PGN
    if is_conversion and is_white:
        return ArtifactKind.CONVERSION_WHITE_PGN
    if is_conversion and is_black:
        return ArtifactKind.CONVERSION_BLACK_PGN
    return ArtifactKind.SUPPLEMENT
