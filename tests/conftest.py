from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest
import pytest_asyncio

from chess_dossier.application.services import OrderService
from chess_dossier.domain.enums import PaymentProvider
from chess_dossier.domain.models import Order
from chess_dossier.infrastructure.db.database import (
    build_engine,
    build_session_factory,
    create_schema,
)
from chess_dossier.infrastructure.db.uow import SqlAlchemyUnitOfWorkFactory
from chess_dossier.infrastructure.pgn import PythonChessPgnInspector
from chess_dossier.infrastructure.storage.local import LocalFileStorage


class FixedClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 8, 6, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.value


class SequentialIds:
    def __init__(self) -> None:
        self.counter = 0

    def uuid(self) -> str:
        self.counter += 1
        return f"00000000-0000-0000-0000-{self.counter:012d}"

    def public_order_id(self, now: datetime) -> str:
        self.counter += 1
        return f"CD-{now:%Y%m%d}-{self.counter:06d}"

    def invoice_payload(self, order: Order, provider: PaymentProvider) -> str:
        return f"test:{provider.value}:{order.id}"


@dataclass
class ServiceBundle:
    service: OrderService
    storage: LocalFileStorage
    clock: FixedClock
    engine: object


@pytest_asyncio.fixture
async def service_bundle(tmp_path: Path) -> AsyncIterator[ServiceBundle]:
    db_path = tmp_path / "test.db"
    engine = build_engine(f"sqlite+aiosqlite:///{db_path}")
    await create_schema(engine)
    session_factory = build_session_factory(engine)
    storage = LocalFileStorage(tmp_path / "storage")
    clock = FixedClock()
    service = OrderService(
        uow_factory=SqlAlchemyUnitOfWorkFactory(session_factory),
        storage=storage,
        pgn_inspector=PythonChessPgnInspector(),
        clock=clock,
        ids=SequentialIds(),
        price_minor=99_000,
        max_daily_orders=3,
        max_games=50,
        max_upload_bytes=1024,
        business_timezone="Europe/Moscow",
    )
    yield ServiceBundle(service=service, storage=storage, clock=clock, engine=engine)
    await engine.dispose()


@pytest.fixture
def valid_pgn() -> bytes:
    return b"""[Event \"Test\"]
[Site \"Local\"]
[Date \"2026.08.06\"]
[Round \"1\"]
[White \"A\"]
[Black \"B\"]
[Result \"1-0\"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
"""
