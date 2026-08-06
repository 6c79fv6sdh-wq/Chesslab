from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from chess_dossier.analysis.models import AnalysisConfig
from chess_dossier.analysis.report import PdfReportRenderer
from chess_dossier.analysis.service import AnalysisPipeline
from chess_dossier.analysis.training import PgnTrainingPackWriter
from chess_dossier.application.analysis_worker import AnalysisWorker, NullAnalysisWorkerNotifier
from chess_dossier.application.dto import CreateOrderCommand
from chess_dossier.application.services import OrderService
from chess_dossier.domain.enums import (
    ArtifactKind,
    OrderStatus,
    ReportLanguage,
    SourceType,
    TimeControl,
)
from chess_dossier.domain.errors import AccessDenied
from chess_dossier.infrastructure.analysis.stockfish import StockfishFactory
from chess_dossier.infrastructure.db.database import (
    build_engine,
    build_session_factory,
    create_schema,
)
from chess_dossier.infrastructure.db.uow import SqlAlchemyUnitOfWorkFactory
from chess_dossier.infrastructure.pgn import PythonChessPgnInspector
from chess_dossier.infrastructure.runtime import SecureIds, SystemClock
from chess_dossier.infrastructure.storage.local import LocalFileStorage

ADMIN_ID = 999
OTHER_ADMIN_ID = 1234
USER_ID = 100
CORPUS = Path(__file__).resolve().parents[2] / "examples" / "demo_games.pgn"


def _stockfish() -> Path | None:
    candidate = Path("/usr/games/stockfish")
    if candidate.is_file():
        return candidate
    discovered = shutil.which("stockfish")
    return Path(discovered) if discovered else None


pytestmark = pytest.mark.skipif(
    _stockfish() is None, reason="Stockfish binary is not installed on this machine"
)


async def test_paid_order_reaches_delivery_through_the_real_engine(tmp_path: Path) -> None:
    binary = _stockfish()
    assert binary is not None
    engine = build_engine(f"sqlite+aiosqlite:///{tmp_path / 'lifecycle.db'}")
    await create_schema(engine)
    storage = LocalFileStorage(tmp_path / "storage")
    service = OrderService(
        uow_factory=SqlAlchemyUnitOfWorkFactory(build_session_factory(engine)),
        storage=storage,
        pgn_inspector=PythonChessPgnInspector(),
        clock=SystemClock(),
        ids=SecureIds(),
        price_minor=99_000,
        max_daily_orders=3,
        max_games=50,
        max_upload_bytes=20 * 1024 * 1024,
        business_timezone="Europe/Moscow",
    )
    worker = AnalysisWorker(
        order_service=service,
        storage=storage,
        runner=AnalysisPipeline(
            engine_factory=StockfishFactory(binary=binary),
            report_renderer=PdfReportRenderer(),
            training_writer=PgnTrainingPackWriter(),
            config=AnalysisConfig(fast_nodes=12_000, deep_nodes=180_000),
        ),
        remote_source=None,
        max_games=50,
        max_source_bytes=20 * 1024 * 1024,
        poll_seconds=1.0,
        notifier=NullAnalysisWorkerNotifier(),
    )

    try:
        order = await service.create_order(
            CreateOrderCommand(
                telegram_user_id=USER_ID,
                source_type=SourceType.PGN,
                time_control=TimeControl.BOTH,
                report_language=ReportLanguage.RU,
                contact="@client",
                rating=1750,
                player_name="DemoPlayer",
                idempotency_key="real-engine-lifecycle",
            )
        )
        order = await service.confirm_manual_payment(order.public_id, ADMIN_ID)
        assert order.status == OrderStatus.AWAITING_SOURCE

        order = await service.submit_pgn(
            public_id=order.public_id,
            telegram_user_id=USER_ID,
            filename="games.pgn",
            content=CORPUS.read_bytes(),
            telegram_file_unique_id="uid-1",
        )
        assert order.status == OrderStatus.QUEUED
        assert order.game_count == 2

        assert await worker.process_next() is True
        order = await service.get_order(order.public_id)
        assert order.status == OrderStatus.REVIEW_PENDING, order.failure_reason
        assert order.failure_reason is None

        artifacts = await service.list_artifacts(order.public_id)
        assert {item.kind for item in artifacts} == {
            ArtifactKind.ANALYSIS_JSON,
            ArtifactKind.REPORT_PDF,
            ArtifactKind.ERRORS_WHITE_PGN,
            ArtifactKind.ERRORS_BLACK_PGN,
            ArtifactKind.CONVERSION_WHITE_PGN,
            ArtifactKind.CONVERSION_BLACK_PGN,
        }

        with pytest.raises(AccessDenied):
            await service.mark_delivered(order.public_id, ADMIN_ID)

        _, preview = await service.prepare_review(order.public_id, ADMIN_ID)
        assert len(preview) == 6
        order = await service.take_order(order.public_id, ADMIN_ID)
        assert order.assigned_admin_id == ADMIN_ID

        with pytest.raises(AccessDenied):
            await service.prepare_delivery(order.public_id, OTHER_ADMIN_ID)

        order, pending = await service.prepare_delivery(order.public_id, ADMIN_ID)
        assert order.status == OrderStatus.READY
        for artifact in pending:
            assert storage.path_for(artifact.storage_key).stat().st_size > 0
            await service.mark_artifact_delivered(
                public_id=order.public_id, artifact_id=artifact.id, admin_id=ADMIN_ID
            )
        order = await service.mark_delivered(order.public_id, ADMIN_ID)
        assert order.status == OrderStatus.DELIVERED
    finally:
        await engine.dispose()
