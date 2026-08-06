from __future__ import annotations

from dataclasses import dataclass

from chess_dossier.domain.enums import ArtifactKind, ReportLanguage, SourceType, TimeControl


@dataclass(frozen=True, slots=True)
class CreateOrderCommand:
    telegram_user_id: int
    source_type: SourceType
    time_control: TimeControl
    report_language: ReportLanguage
    contact: str
    idempotency_key: str
    rating: int | None = None
    player_name: str | None = None


@dataclass(frozen=True, slots=True)
class PgnInspection:
    game_count: int
    warnings: tuple[str, ...] = ()
    matching_game_count: int | None = None


@dataclass(frozen=True, slots=True)
class StoredFile:
    key: str
    checksum_sha256: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class DeliveryFile:
    kind: ArtifactKind
    original_name: str
    content: bytes
    telegram_file_id: str | None = None
