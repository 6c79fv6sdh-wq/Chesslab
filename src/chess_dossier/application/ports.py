from __future__ import annotations

from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Protocol

from chess_dossier.application.dto import PgnInspection, StoredFile
from chess_dossier.domain.enums import OrderStatus, PaymentProvider
from chess_dossier.domain.models import Artifact, Order, OrderEvent, Payment


class OrderRepository(Protocol):
    async def add(self, order: Order) -> None: ...

    async def get(self, public_id: str) -> Order | None: ...

    async def get_by_internal_id(self, internal_id: str) -> Order | None: ...

    async def get_by_idempotency_key(self, key: str) -> Order | None: ...

    async def save(self, order: Order) -> None: ...

    async def count_created_between(self, start: datetime, end: datetime) -> int: ...

    async def list_for_user(self, telegram_user_id: int, limit: int = 10) -> list[Order]: ...

    async def list_by_statuses(
        self, statuses: set[OrderStatus], limit: int = 20
    ) -> list[Order]: ...

    async def add_event(self, event: OrderEvent) -> None: ...

    async def add_payment(self, payment: Payment) -> None: ...

    async def get_payment_by_payload(self, payload: str) -> Payment | None: ...

    async def get_payment_by_charge(self, charge_id: str) -> Payment | None: ...

    async def save_payment(self, payment: Payment) -> None: ...

    async def upsert_artifact(self, artifact: Artifact) -> Artifact: ...

    async def list_artifacts(self, order_id: str) -> list[Artifact]: ...

    async def mark_artifact_delivered(
        self, *, order_id: str, artifact_id: str, delivered_at: datetime
    ) -> bool: ...


class UnitOfWork(Protocol):
    @property
    def orders(self) -> OrderRepository: ...

    async def __aenter__(self) -> UnitOfWork: ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None: ...

    async def commit(self) -> None: ...

    async def rollback(self) -> None: ...


class UnitOfWorkFactory(Protocol):
    def __call__(self) -> UnitOfWork: ...


class FileStorage(Protocol):
    async def save(
        self, *, order_id: str, category: str, filename: str, content: bytes
    ) -> StoredFile: ...

    def path_for(self, key: str) -> Path: ...

    async def read(self, key: str) -> bytes: ...


class PgnInspector(Protocol):
    def inspect(
        self,
        content: bytes,
        *,
        max_games: int,
        required_player: str | None = None,
        allow_position_tasks: bool = False,
        expected_orientation: str | None = None,
    ) -> PgnInspection: ...


class Clock(Protocol):
    def now(self) -> datetime: ...


class IdGenerator(Protocol):
    def uuid(self) -> str: ...

    def public_order_id(self, now: datetime) -> str: ...

    def invoice_payload(self, order: Order, provider: PaymentProvider) -> str: ...
