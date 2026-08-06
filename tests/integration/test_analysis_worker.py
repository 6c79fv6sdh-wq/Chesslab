from __future__ import annotations

import hashlib
import json
from typing import cast

import pytest

from chess_dossier.analysis.models import AnalysisResult, GeneratedAnalysis, GeneratedFile
from chess_dossier.application.analysis_worker import AnalysisWorker
from chess_dossier.application.dto import CreateOrderCommand
from chess_dossier.application.services import OrderService
from chess_dossier.domain.enums import (
    ArtifactKind,
    OrderStatus,
    ReportLanguage,
    SourceType,
    TimeControl,
)
from chess_dossier.domain.errors import ActiveOrderExists
from chess_dossier.domain.models import Order


def command(key: str) -> CreateOrderCommand:
    return CreateOrderCommand(
        telegram_user_id=100,
        source_type=SourceType.PGN,
        time_control=TimeControl.BLITZ,
        report_language=ReportLanguage.RU,
        contact="@tester",
        rating=1800,
        player_name="A",
        idempotency_key=key,
    )


class StubRunner:
    def __init__(
        self, files: tuple[GeneratedFile, ...], *, failure: Exception | None = None
    ) -> None:
        self._files = files
        self._failure = failure
        self.calls = 0

    def run(self, **kwargs: object) -> GeneratedAnalysis:
        del kwargs
        self.calls += 1
        if self._failure is not None:
            raise self._failure
        return GeneratedAnalysis(result=cast(AnalysisResult, object()), files=self._files)


class RecordingNotifier:
    def __init__(self) -> None:
        self.completed_orders: list[str] = []
        self.failed_orders: list[str] = []

    async def completed(self, order: Order) -> None:
        self.completed_orders.append(order.public_id)

    async def failed(self, order: Order) -> None:
        self.failed_orders.append(order.public_id)


class StubRemoteSource:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.usernames: list[str] = []

    async def fetch(self, **kwargs: object) -> bytes:
        self.usernames.append(str(kwargs["username"]))
        return self.payload


def generated_files(valid_pgn: bytes, *, subject: str = "A") -> tuple[GeneratedFile, ...]:
    def oriented(side: str) -> bytes:
        return valid_pgn.replace(
            b'[Result "1-0"]', f'[Result "1-0"]\n[Orientation "{side}"]'.encode()
        )

    return (
        GeneratedFile(
            kind=ArtifactKind.ANALYSIS_JSON,
            filename="analysis.json",
            content=json.dumps(
                {
                    "schema_version": "1.0",
                    "subject": subject,
                    "source_sha256": hashlib.sha256(valid_pgn).hexdigest(),
                    "report_language": "ru",
                }
            ).encode(),
        ),
        GeneratedFile(
            kind=ArtifactKind.REPORT_PDF,
            filename="report.pdf",
            content=b"%PDF-1.4\n%%EOF",
        ),
        GeneratedFile(
            kind=ArtifactKind.ERRORS_WHITE_PGN,
            filename="errors_WHITE.pgn",
            content=oriented("white"),
        ),
        GeneratedFile(
            kind=ArtifactKind.ERRORS_BLACK_PGN,
            filename="errors_BLACK.pgn",
            content=oriented("black"),
        ),
        GeneratedFile(
            kind=ArtifactKind.CONVERSION_WHITE_PGN,
            filename="conversion_WHITE.pgn",
            content=oriented("white"),
        ),
        GeneratedFile(
            kind=ArtifactKind.CONVERSION_BLACK_PGN,
            filename="conversion_BLACK.pgn",
            content=oriented("black"),
        ),
    )


async def queued_order(service: OrderService, valid_pgn: bytes, key: str) -> Order:
    order = await service.create_order(command(key))
    order = await service.confirm_manual_payment(order.public_id, 777)
    return await service.submit_pgn(
        public_id=order.public_id,
        telegram_user_id=100,
        filename="games.pgn",
        content=valid_pgn,
        telegram_file_unique_id=f"file-{key}",
    )


@pytest.mark.asyncio
async def test_worker_generates_reviewable_bundle(service_bundle, valid_pgn: bytes) -> None:
    service = service_bundle.service
    order = await queued_order(service, valid_pgn, "automated-success")
    runner = StubRunner(generated_files(valid_pgn))
    notifier = RecordingNotifier()
    worker = AnalysisWorker(
        order_service=service,
        storage=service_bundle.storage,
        runner=runner,
        remote_source=None,
        max_games=50,
        max_source_bytes=1024,
        poll_seconds=1,
        notifier=notifier,
    )

    assert await worker.process_next()
    result = await service.get_order(order.public_id)
    assert result.status == OrderStatus.REVIEW_PENDING
    assert result.assigned_admin_id is None
    assert runner.calls == 1
    assert notifier.completed_orders == [order.public_id]
    assert len(await service.list_artifacts(order.public_id)) == 6

    reviewed, preview = await service.prepare_review(order.public_id, 777)
    assert reviewed.status == OrderStatus.REVIEW_PENDING
    assert len(preview) == 6
    claimed = await service.take_order(order.public_id, 777)
    assert claimed.assigned_admin_id == 777
    ready, _ = await service.prepare_delivery(order.public_id, 777)
    assert ready.status == OrderStatus.READY


@pytest.mark.asyncio
async def test_worker_failure_is_persisted_and_retryable(service_bundle, valid_pgn: bytes) -> None:
    service = service_bundle.service
    order = await queued_order(service, valid_pgn, "automated-failure")
    notifier = RecordingNotifier()
    worker = AnalysisWorker(
        order_service=service,
        storage=service_bundle.storage,
        runner=StubRunner((), failure=RuntimeError("engine stopped")),
        remote_source=None,
        max_games=50,
        max_source_bytes=1024,
        poll_seconds=1,
        notifier=notifier,
    )

    assert await worker.process_next()
    failed = await service.get_order(order.public_id)
    assert failed.status == OrderStatus.FAILED
    assert failed.failure_reason == "RuntimeError: engine stopped"
    assert notifier.failed_orders == [order.public_id]
    with pytest.raises(ActiveOrderExists):
        await service.create_order(command("blocked-while-failed"))

    requeued = await service.requeue_automated_analysis(order.public_id, admin_id=777)
    assert requeued.status == OrderStatus.QUEUED
    assert requeued.failure_reason is None


@pytest.mark.asyncio
async def test_worker_fetches_and_persists_lichess_corpus(service_bundle, valid_pgn: bytes) -> None:
    service = service_bundle.service
    lichess_pgn = valid_pgn.replace(b'[White "A"]', b'[White "DemoUser"]')
    order = await service.create_order(
        CreateOrderCommand(
            telegram_user_id=100,
            source_type=SourceType.LICHESS,
            time_control=TimeControl.BLITZ,
            report_language=ReportLanguage.RU,
            contact="@tester",
            idempotency_key="lichess-worker",
        )
    )
    order = await service.confirm_manual_payment(order.public_id, 777)
    order = await service.submit_lichess_reference(
        public_id=order.public_id,
        telegram_user_id=100,
        reference="https://lichess.org/@/DemoUser",
    )
    source = StubRemoteSource(lichess_pgn)
    worker = AnalysisWorker(
        order_service=service,
        storage=service_bundle.storage,
        runner=StubRunner(generated_files(lichess_pgn, subject="DemoUser")),
        remote_source=source,
        max_games=50,
        max_source_bytes=1024,
        poll_seconds=1,
        notifier=RecordingNotifier(),
    )

    assert await worker.process_next()
    completed = await service.get_order(order.public_id)
    assert completed.status == OrderStatus.REVIEW_PENDING
    assert completed.player_name == "DemoUser"
    assert completed.source_storage_key is not None
    assert completed.game_count == 1
    assert source.usernames == ["DemoUser"]
