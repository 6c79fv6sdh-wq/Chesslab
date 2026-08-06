from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from chess_dossier.domain.enums import (
    ALLOWED_TRANSITIONS,
    ActorType,
    ArtifactKind,
    OrderStatus,
    PaymentProvider,
    PaymentStatus,
    ReportLanguage,
    SourceType,
    TimeControl,
)
from chess_dossier.domain.errors import AccessDenied, InvalidTransition


@dataclass(slots=True)
class Order:
    id: str
    public_id: str
    telegram_user_id: int
    status: OrderStatus
    source_type: SourceType
    time_control: TimeControl
    report_language: ReportLanguage
    contact: str
    price_minor: int
    currency: str
    idempotency_key: str
    created_at: datetime
    updated_at: datetime
    rating: int | None = None
    player_name: str | None = None
    source_reference: str | None = None
    source_storage_key: str | None = None
    source_original_name: str | None = None
    source_file_unique_id: str | None = None
    source_checksum: str | None = None
    game_count: int | None = None
    assigned_admin_id: int | None = None
    paid_at: datetime | None = None
    queued_at: datetime | None = None
    delivered_at: datetime | None = None
    failure_reason: str | None = None
    version: int = 1
    artifact_kinds: set[ArtifactKind] = field(default_factory=set)

    def transition(self, target: OrderStatus, *, at: datetime) -> tuple[OrderStatus, OrderStatus]:
        if target == self.status:
            return self.status, target
        if target not in ALLOWED_TRANSITIONS[self.status]:
            raise InvalidTransition(f"Cannot move order from {self.status} to {target}")
        previous = self.status
        self.status = target
        self.updated_at = at
        self.version += 1
        if target == OrderStatus.PAID:
            self.paid_at = at
        elif target == OrderStatus.QUEUED:
            self.queued_at = at
        elif target == OrderStatus.DELIVERED:
            self.delivered_at = at
        return previous, target

    def require_owner(self, telegram_user_id: int) -> None:
        if self.telegram_user_id != telegram_user_id:
            raise AccessDenied("Order belongs to another user")


@dataclass(frozen=True, slots=True)
class OrderEvent:
    id: str
    order_id: str
    from_status: OrderStatus | None
    to_status: OrderStatus
    actor_type: ActorType
    actor_id: int | None
    reason: str
    created_at: datetime


@dataclass(slots=True)
class Payment:
    id: str
    order_id: str
    provider: PaymentProvider
    status: PaymentStatus
    amount: int
    currency: str
    invoice_payload: str
    created_at: datetime
    external_charge_id: str | None = None
    confirmed_at: datetime | None = None


@dataclass(slots=True)
class Artifact:
    id: str
    order_id: str
    kind: ArtifactKind
    storage_key: str
    original_name: str
    checksum_sha256: str
    created_at: datetime
    telegram_file_id: str | None = None
    delivered_at: datetime | None = None
