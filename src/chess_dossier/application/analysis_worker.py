from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from typing import Protocol

from chess_dossier.analysis.models import GeneratedAnalysis
from chess_dossier.application.dto import DeliveryFile
from chess_dossier.application.ports import FileStorage
from chess_dossier.application.services import OrderService
from chess_dossier.domain.enums import OrderStatus, ReportLanguage, SourceType, TimeControl
from chess_dossier.domain.errors import DomainError
from chess_dossier.domain.models import Order

logger = logging.getLogger(__name__)


class AnalysisRunner(Protocol):
    def run(
        self,
        *,
        pgn_content: bytes,
        player_name: str,
        report_language: ReportLanguage,
        max_games: int,
        time_control: TimeControl | None = None,
    ) -> GeneratedAnalysis: ...


class RemoteGameSource(Protocol):
    async def fetch(
        self,
        *,
        username: str,
        time_control: TimeControl,
        max_games: int,
        max_bytes: int,
    ) -> bytes: ...


class AnalysisWorkerNotifier(Protocol):
    async def completed(self, order: Order) -> None: ...

    async def failed(self, order: Order) -> None: ...


class NullAnalysisWorkerNotifier:
    async def completed(self, order: Order) -> None:
        del order

    async def failed(self, order: Order) -> None:
        del order


@dataclass(slots=True)
class AnalysisWorker:
    order_service: OrderService
    storage: FileStorage
    runner: AnalysisRunner
    remote_source: RemoteGameSource | None
    max_games: int
    max_source_bytes: int
    poll_seconds: float
    notifier: AnalysisWorkerNotifier

    async def process_next(self) -> bool:
        queued = await self.order_service.list_queued_orders(limit=1)
        if not queued:
            return False
        candidate = queued[0]
        try:
            order = await self.order_service.begin_automated_analysis(candidate.public_id)
        except DomainError:
            logger.info("Queued order %s was claimed elsewhere", candidate.public_id)
            return False

        try:
            pgn_content, order = await self._source_for(order)
            player_name = order.player_name
            if not player_name:
                raise ValueError("Order has no exact PGN player name")
            generated = await asyncio.to_thread(
                self.runner.run,
                pgn_content=pgn_content,
                player_name=player_name,
                report_language=order.report_language,
                max_games=self.max_games,
                time_control=order.time_control,
            )
            for item in generated.files:
                await self.order_service.add_generated_artifact(
                    public_id=order.public_id,
                    delivery=DeliveryFile(
                        kind=item.kind,
                        original_name=item.filename,
                        content=item.content,
                    ),
                )
            order = await self.order_service.complete_automated_analysis(order.public_id)
        except Exception as exc:
            reason = f"{type(exc).__name__}: {exc}"[:2_000]
            logger.exception("Automated analysis failed for %s", order.public_id)
            try:
                order = await self.order_service.fail_automated_analysis(
                    order.public_id, reason=reason
                )
            except DomainError:
                logger.exception("Could not persist analysis failure for %s", order.public_id)
                try:
                    order = await self.order_service.get_order(order.public_id)
                except DomainError:
                    logger.exception("Could not reload conflicted order %s", order.public_id)
            if order.status == OrderStatus.FAILED:
                await self._notify_failure(order)
            return True

        await self._notify_completion(order)
        return True

    async def run_forever(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                processed = await self.process_next()
            except Exception:
                logger.exception("Analysis worker iteration failed before an order was claimed")
                processed = False
            if processed:
                continue
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.poll_seconds)
            except TimeoutError:
                pass

    async def _source_for(self, order: Order) -> tuple[bytes, Order]:
        if order.source_type == SourceType.LICHESS:
            if self.remote_source is None or not order.source_reference:
                raise ValueError("Lichess source adapter or username is missing")
            payload = await self.remote_source.fetch(
                username=order.source_reference,
                time_control=order.time_control,
                max_games=self.max_games,
                max_bytes=self.max_source_bytes,
            )
            updated = await self.order_service.record_fetched_pgn(
                public_id=order.public_id,
                filename=f"lichess-{order.source_reference}.pgn",
                content=payload,
            )
            return payload, updated

        if not order.source_storage_key:
            raise ValueError("Uploaded PGN storage key is missing")
        payload = await self.storage.read(order.source_storage_key)
        checksum = hashlib.sha256(payload).hexdigest()
        if order.source_checksum and checksum != order.source_checksum:
            raise ValueError("Stored PGN checksum mismatch")
        return payload, order

    async def _notify_completion(self, order: Order) -> None:
        try:
            await self.notifier.completed(order)
        except Exception:
            logger.exception("Completion notification failed for %s", order.public_id)

    async def _notify_failure(self, order: Order) -> None:
        try:
            await self.notifier.failed(order)
        except Exception:
            logger.exception("Failure notification failed for %s", order.public_id)
