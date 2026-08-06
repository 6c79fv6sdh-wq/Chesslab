from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine

from chess_dossier.analysis.report import PdfReportRenderer
from chess_dossier.analysis.service import AnalysisPipeline
from chess_dossier.analysis.training import PgnTrainingPackWriter
from chess_dossier.application.services import OrderService
from chess_dossier.config import Settings
from chess_dossier.infrastructure.analysis.lichess import LichessGameSource
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


@dataclass(slots=True)
class Application:
    settings: Settings
    engine: AsyncEngine
    order_service: OrderService
    file_storage: LocalFileStorage
    analysis_pipeline: AnalysisPipeline | None = None
    lichess_source: LichessGameSource | None = None

    async def close(self) -> None:
        await self.engine.dispose()


async def build_application(settings: Settings | None = None) -> Application:
    settings = settings or Settings()
    engine = build_engine(settings.database_url)
    if settings.auto_create_schema:
        await create_schema(engine)
    session_factory = build_session_factory(engine)
    file_storage = LocalFileStorage(settings.storage_root)
    order_service = OrderService(
        uow_factory=SqlAlchemyUnitOfWorkFactory(session_factory),
        storage=file_storage,
        pgn_inspector=PythonChessPgnInspector(),
        clock=SystemClock(),
        ids=SecureIds(),
        price_minor=settings.price_minor,
        max_daily_orders=settings.max_daily_orders,
        max_games=settings.max_games_per_order,
        max_upload_bytes=settings.max_upload_bytes,
        business_timezone=settings.business_timezone,
    )
    analysis_pipeline: AnalysisPipeline | None = None
    lichess_source: LichessGameSource | None = None
    if settings.analysis_enabled:
        analysis_pipeline = AnalysisPipeline(
            engine_factory=StockfishFactory(
                binary=settings.stockfish_path,
                threads=settings.stockfish_threads,
                hash_mb=settings.stockfish_hash_mb,
            ),
            report_renderer=PdfReportRenderer(brand_name=settings.brand_name),
            training_writer=PgnTrainingPackWriter(),
            config=settings.analysis_config,
        )
        lichess_source = LichessGameSource(
            base_url=settings.lichess_base_url,
            token=(
                settings.lichess_api_token.get_secret_value()
                if settings.lichess_api_token is not None
                else None
            ),
            user_agent=f"chess-dossier/0.2 ({settings.support_contact})",
        )
    return Application(
        settings=settings,
        engine=engine,
        order_service=order_service,
        file_storage=file_storage,
        analysis_pipeline=analysis_pipeline,
        lichess_source=lichess_source,
    )
