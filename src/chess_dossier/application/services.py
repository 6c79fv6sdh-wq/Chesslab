from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from chess_dossier.application.dto import CreateOrderCommand, DeliveryFile
from chess_dossier.application.ports import (
    Clock,
    FileStorage,
    IdGenerator,
    PgnInspector,
    UnitOfWork,
    UnitOfWorkFactory,
)
from chess_dossier.domain.enums import (
    REQUIRED_DELIVERABLES,
    ActorType,
    ArtifactKind,
    OrderStatus,
    PaymentProvider,
    PaymentStatus,
    SourceType,
)
from chess_dossier.domain.errors import (
    AccessDenied,
    ActiveOrderExists,
    CapacityExceeded,
    InvalidArtifact,
    InvalidSource,
    InvalidTransition,
    OrderNotFound,
    PaymentError,
)
from chess_dossier.domain.models import Artifact, Order, OrderEvent, Payment

_AUTOMATED_DELIVERABLES = REQUIRED_DELIVERABLES | {ArtifactKind.ANALYSIS_JSON}


class OrderService:
    def __init__(
        self,
        *,
        uow_factory: UnitOfWorkFactory,
        storage: FileStorage,
        pgn_inspector: PgnInspector,
        clock: Clock,
        ids: IdGenerator,
        price_minor: int,
        max_daily_orders: int,
        max_games: int,
        max_upload_bytes: int,
        business_timezone: str,
    ) -> None:
        self._uow_factory = uow_factory
        self._storage = storage
        self._pgn_inspector = pgn_inspector
        self._clock = clock
        self._ids = ids
        self._price_minor = price_minor
        self._max_daily_orders = max_daily_orders
        self._max_games = max_games
        self._max_upload_bytes = max_upload_bytes
        self._timezone = ZoneInfo(business_timezone)

    async def create_order(self, command: CreateOrderCommand) -> Order:
        now = self._clock.now()
        start, end = self._business_day_bounds(now)
        async with self._uow_factory() as uow:
            duplicate = await uow.orders.get_by_idempotency_key(command.idempotency_key)
            if duplicate:
                duplicate.require_owner(command.telegram_user_id)
                return duplicate
            existing_orders = await uow.orders.list_for_user(command.telegram_user_id, limit=10)
            terminal = {OrderStatus.DELIVERED, OrderStatus.CANCELED}
            if any(existing.status not in terminal for existing in existing_orders):
                raise ActiveOrderExists("User already has an active order")
            if await uow.orders.count_created_between(start, end) >= self._max_daily_orders:
                raise CapacityExceeded("Daily order capacity is exhausted")
            order = Order(
                id=self._ids.uuid(),
                public_id=self._ids.public_order_id(now),
                telegram_user_id=command.telegram_user_id,
                status=OrderStatus.AWAITING_PAYMENT,
                source_type=command.source_type,
                time_control=command.time_control,
                report_language=command.report_language,
                contact=command.contact,
                rating=command.rating,
                player_name=command.player_name,
                price_minor=self._price_minor,
                currency="RUB",
                idempotency_key=command.idempotency_key,
                created_at=now,
                updated_at=now,
            )
            await uow.orders.add(order)
            await uow.orders.add_event(
                self._event(
                    order, None, order.status, ActorType.USER, command.telegram_user_id, "created"
                )
            )
            await uow.commit()
            return order

    async def report_manual_payment(self, public_id: str, telegram_user_id: int) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            order.require_owner(telegram_user_id)
            if order.status == OrderStatus.PAYMENT_REVIEW:
                return order
            if order.status in {
                OrderStatus.AWAITING_SOURCE,
                OrderStatus.QUEUED,
                OrderStatus.IN_PROGRESS,
                OrderStatus.REVIEW_PENDING,
                OrderStatus.READY,
                OrderStatus.DELIVERED,
            }:
                return order
            previous, target = order.transition(OrderStatus.PAYMENT_REVIEW, at=self._clock.now())
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(
                    order,
                    previous,
                    target,
                    ActorType.USER,
                    telegram_user_id,
                    "payment_reported",
                )
            )
            await uow.commit()
            return order

    async def prepare_stars_payment(self, public_id: str, stars_amount: int) -> Payment:
        if stars_amount <= 0:
            raise PaymentError("STAR_PRICE must be a positive integer")
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status not in {OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_REVIEW}:
                raise PaymentError("Order is not awaiting payment")
            payload = self._ids.invoice_payload(order, PaymentProvider.TELEGRAM_STARS)
            existing = await uow.orders.get_payment_by_payload(payload)
            if existing:
                return existing
            payment = Payment(
                id=self._ids.uuid(),
                order_id=order.id,
                provider=PaymentProvider.TELEGRAM_STARS,
                status=PaymentStatus.CREATED,
                amount=stars_amount,
                currency="XTR",
                invoice_payload=payload,
                created_at=self._clock.now(),
            )
            await uow.orders.add_payment(payment)
            await uow.commit()
            return payment

    async def confirm_stars_payment(
        self,
        *,
        payload: str,
        charge_id: str,
        amount: int,
        currency: str,
    ) -> Order:
        async with self._uow_factory() as uow:
            duplicate = await uow.orders.get_payment_by_charge(charge_id)
            if duplicate:
                if (
                    duplicate.invoice_payload != payload
                    or duplicate.amount != amount
                    or duplicate.currency != currency
                ):
                    raise PaymentError("Charge ID is already bound to another payment")
                order = await self._require_order_by_internal_id(uow, duplicate.order_id)
                return order
            payment = await uow.orders.get_payment_by_payload(payload)
            if payment is None:
                raise PaymentError("Unknown invoice payload")
            if payment.amount != amount or payment.currency != currency or currency != "XTR":
                raise PaymentError("Payment amount or currency mismatch")
            order = await self._require_order_by_internal_id(uow, payment.order_id)
            payment.status = PaymentStatus.CONFIRMED
            payment.external_charge_id = charge_id
            payment.confirmed_at = self._clock.now()
            await uow.orders.save_payment(payment)
            await self._move_to_awaiting_source(
                uow, order, PaymentProvider.TELEGRAM_STARS.value, ActorType.SYSTEM, None
            )
            await uow.commit()
            return order

    async def validate_stars_payment(self, *, payload: str, amount: int, currency: str) -> bool:
        if currency != "XTR":
            return False
        async with self._uow_factory() as uow:
            payment = await uow.orders.get_payment_by_payload(payload)
            if payment is None:
                return False
            if payment.status == PaymentStatus.CONFIRMED:
                return False
            order = await self._require_order_by_internal_id(uow, payment.order_id)
            return (
                order.status in {OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_REVIEW}
                and payment.amount == amount
                and payment.currency == currency
            )

    async def confirm_manual_payment(self, public_id: str, admin_id: int) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status in {
                OrderStatus.AWAITING_SOURCE,
                OrderStatus.QUEUED,
                OrderStatus.IN_PROGRESS,
                OrderStatus.REVIEW_PENDING,
                OrderStatus.READY,
                OrderStatus.DELIVERED,
            }:
                return order
            if order.status not in {OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_REVIEW}:
                raise PaymentError("Order cannot be paid in its current status")
            payment = Payment(
                id=self._ids.uuid(),
                order_id=order.id,
                provider=PaymentProvider.MANUAL_ADMIN,
                status=PaymentStatus.CONFIRMED,
                amount=order.price_minor,
                currency=order.currency,
                invoice_payload=self._ids.invoice_payload(order, PaymentProvider.MANUAL_ADMIN),
                external_charge_id=f"admin:{admin_id}:{order.public_id}",
                created_at=self._clock.now(),
                confirmed_at=self._clock.now(),
            )
            await uow.orders.add_payment(payment)
            await self._move_to_awaiting_source(
                uow,
                order,
                PaymentProvider.MANUAL_ADMIN.value,
                ActorType.ADMIN,
                admin_id,
            )
            await uow.commit()
            return order

    async def submit_pgn(
        self,
        *,
        public_id: str,
        telegram_user_id: int,
        filename: str,
        content: bytes,
        telegram_file_unique_id: str | None,
    ) -> Order:
        self._validate_upload_size(content)
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            order.require_owner(telegram_user_id)
            if order.source_type == SourceType.LICHESS:
                raise InvalidSource("This order expects a Lichess username or profile URL")
            if order.status != OrderStatus.AWAITING_SOURCE:
                if (
                    order.source_file_unique_id
                    and order.source_file_unique_id == telegram_file_unique_id
                ):
                    return order
                raise InvalidSource("Order is not awaiting source material")
            if not order.player_name:
                raise InvalidSource("Player name from PGN headers is missing")
            inspection = self._pgn_inspector.inspect(
                content,
                max_games=self._max_games,
                required_player=order.player_name,
            )
            stored = await self._storage.save(
                order_id=order.id,
                category="source",
                filename=filename,
                content=content,
            )
            order.source_storage_key = stored.key
            order.source_original_name = filename
            order.source_file_unique_id = telegram_file_unique_id
            order.source_checksum = stored.checksum_sha256
            order.game_count = inspection.game_count
            previous, target = order.transition(OrderStatus.QUEUED, at=self._clock.now())
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(
                    order,
                    previous,
                    target,
                    ActorType.USER,
                    telegram_user_id,
                    "pgn_received",
                )
            )
            await uow.commit()
            return order

    async def submit_lichess_reference(
        self, *, public_id: str, telegram_user_id: int, reference: str
    ) -> Order:
        normalized = normalize_lichess_reference(reference)
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            order.require_owner(telegram_user_id)
            if order.source_type != SourceType.LICHESS:
                raise InvalidSource("This order expects a PGN file")
            if order.status != OrderStatus.AWAITING_SOURCE:
                if order.source_reference == normalized:
                    return order
                raise InvalidSource("Order is not awaiting source material")
            order.source_reference = normalized
            order.player_name = normalized
            previous, target = order.transition(OrderStatus.QUEUED, at=self._clock.now())
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(
                    order,
                    previous,
                    target,
                    ActorType.USER,
                    telegram_user_id,
                    "lichess_reference_received",
                )
            )
            await uow.commit()
            return order

    async def list_queued_orders(self, *, limit: int = 1) -> list[Order]:
        if limit < 1:
            raise ValueError("limit must be positive")
        async with self._uow_factory() as uow:
            return await uow.orders.list_by_statuses({OrderStatus.QUEUED}, limit=limit)

    async def begin_automated_analysis(self, public_id: str) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status != OrderStatus.QUEUED:
                raise InvalidTransition("Only a queued order can start automated analysis")
            if order.assigned_admin_id is not None:
                raise AccessDenied("An administrator has already claimed this order")
            previous, target = order.transition(OrderStatus.IN_PROGRESS, at=self._clock.now())
            order.failure_reason = None
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(order, previous, target, ActorType.SYSTEM, None, "analysis_started")
            )
            await uow.commit()
            return order

    async def record_fetched_pgn(self, *, public_id: str, filename: str, content: bytes) -> Order:
        self._validate_upload_size(content)
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            self._require_unassigned_automation(order)
            if order.source_type != SourceType.LICHESS:
                raise InvalidSource("Only a Lichess order accepts a fetched source")
            if not order.player_name and order.source_reference:
                order.player_name = order.source_reference
            if not order.player_name:
                raise InvalidSource("Lichess player name is missing")
            inspection = self._pgn_inspector.inspect(
                content,
                max_games=self._max_games,
                required_player=order.player_name,
            )
            stored = await self._storage.save(
                order_id=order.id,
                category="source",
                filename=filename,
                content=content,
            )
            order.source_storage_key = stored.key
            order.source_original_name = filename
            order.source_checksum = stored.checksum_sha256
            order.game_count = inspection.game_count
            order.updated_at = self._clock.now()
            order.version += 1
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(
                    order,
                    order.status,
                    order.status,
                    ActorType.SYSTEM,
                    None,
                    "lichess_pgn_fetched",
                )
            )
            await uow.commit()
            return order

    async def add_generated_artifact(self, *, public_id: str, delivery: DeliveryFile) -> Artifact:
        self._validate_delivery(delivery)
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            self._require_unassigned_automation(order)
            self._validate_delivery_for_order(order, delivery)
            artifact = await self._store_artifact(uow, order, delivery)
            await uow.commit()
            return artifact

    async def complete_automated_analysis(self, public_id: str) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            self._require_unassigned_automation(order)
            artifacts = await uow.orders.list_artifacts(order.id)
            self._require_bundle(artifacts, automated=True)
            previous, target = order.transition(OrderStatus.REVIEW_PENDING, at=self._clock.now())
            order.failure_reason = None
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(
                    order,
                    previous,
                    target,
                    ActorType.SYSTEM,
                    None,
                    "analysis_generated",
                )
            )
            await uow.commit()
            return order

    async def fail_automated_analysis(self, public_id: str, *, reason: str) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status == OrderStatus.FAILED:
                return order
            self._require_unassigned_automation(order)
            previous, target = order.transition(OrderStatus.FAILED, at=self._clock.now())
            order.failure_reason = reason.strip()[:2_000] or "Automated analysis failed"
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(order, previous, target, ActorType.SYSTEM, None, "analysis_failed")
            )
            await uow.commit()
            return order

    async def requeue_automated_analysis(self, public_id: str, admin_id: int) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status == OrderStatus.QUEUED:
                return order
            if order.status not in {
                OrderStatus.FAILED,
                OrderStatus.IN_PROGRESS,
                OrderStatus.REVIEW_PENDING,
            }:
                raise InvalidTransition("This order cannot be returned to the analysis queue")
            if order.assigned_admin_id is not None:
                raise AccessDenied("Release the assigned manual workflow before retrying")
            previous, target = order.transition(OrderStatus.QUEUED, at=self._clock.now())
            order.failure_reason = None
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(order, previous, target, ActorType.ADMIN, admin_id, "analysis_requeued")
            )
            await uow.commit()
            return order

    async def prepare_review(self, public_id: str, admin_id: int) -> tuple[Order, list[Artifact]]:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status not in {OrderStatus.REVIEW_PENDING, OrderStatus.READY}:
                raise InvalidArtifact("Generated analysis is not awaiting review")
            if order.assigned_admin_id is not None:
                self._require_assigned_admin(order, admin_id)
            artifacts = await uow.orders.list_artifacts(order.id)
            self._require_bundle(artifacts, automated=True)
            await uow.orders.add_event(
                self._event(
                    order,
                    order.status,
                    order.status,
                    ActorType.ADMIN,
                    admin_id,
                    "analysis_previewed",
                )
            )
            await uow.commit()
            return order, artifacts

    async def take_order(self, public_id: str, admin_id: int) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status in {OrderStatus.REVIEW_PENDING, OrderStatus.READY}:
                if order.assigned_admin_id is None:
                    order.assigned_admin_id = admin_id
                    await uow.orders.save(order)
                    await uow.orders.add_event(
                        self._event(
                            order,
                            order.status,
                            order.status,
                            ActorType.ADMIN,
                            admin_id,
                            "claimed_generated_analysis",
                        )
                    )
                    await uow.commit()
                    return order
                self._require_assigned_admin(order, admin_id)
                return order
            if order.status == OrderStatus.IN_PROGRESS:
                if order.assigned_admin_id is None:
                    raise InvalidTransition("Automated analysis is still running")
                self._require_assigned_admin(order, admin_id)
                return order
            if order.status not in {OrderStatus.QUEUED, OrderStatus.FAILED}:
                raise InvalidTransition("Only a queued or failed order can enter manual work")
            recovered_from_failure = order.status == OrderStatus.FAILED
            previous, target = order.transition(OrderStatus.IN_PROGRESS, at=self._clock.now())
            order.assigned_admin_id = admin_id
            order.failure_reason = None
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(
                    order,
                    previous,
                    target,
                    ActorType.ADMIN,
                    admin_id,
                    "taken_after_failure" if recovered_from_failure else "taken",
                )
            )
            await uow.commit()
            return order

    async def add_artifact(
        self, *, public_id: str, admin_id: int, delivery: DeliveryFile
    ) -> Artifact:
        self._validate_delivery(delivery)
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            if order.status not in {
                OrderStatus.IN_PROGRESS,
                OrderStatus.REVIEW_PENDING,
                OrderStatus.READY,
            }:
                raise InvalidArtifact("Order must be in progress before artifacts are attached")
            self._require_assigned_admin(order, admin_id)
            self._validate_delivery_for_order(order, delivery)
            artifact = await self._store_artifact(uow, order, delivery)
            await uow.commit()
            return artifact

    async def prepare_delivery(self, public_id: str, admin_id: int) -> tuple[Order, list[Artifact]]:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            self._require_assigned_admin(order, admin_id)
            artifacts = await uow.orders.list_artifacts(order.id)
            self._require_bundle(artifacts, automated=False)
            if order.status in {OrderStatus.IN_PROGRESS, OrderStatus.REVIEW_PENDING}:
                previous, target = order.transition(OrderStatus.READY, at=self._clock.now())
                await uow.orders.save(order)
                await uow.orders.add_event(
                    self._event(order, previous, target, ActorType.ADMIN, admin_id, "ready")
                )
                await uow.commit()
            elif order.status != OrderStatus.READY:
                raise InvalidArtifact("Order cannot be prepared for delivery")
            return order, artifacts

    async def mark_artifact_delivered(
        self, *, public_id: str, artifact_id: str, admin_id: int
    ) -> None:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            self._require_assigned_admin(order, admin_id)
            if order.status != OrderStatus.READY:
                raise InvalidArtifact("Order must be ready before files are delivered")
            found = await uow.orders.mark_artifact_delivered(
                order_id=order.id,
                artifact_id=artifact_id,
                delivered_at=self._clock.now(),
            )
            if not found:
                raise InvalidArtifact("Artifact does not belong to this order")
            await uow.commit()

    async def mark_delivered(self, public_id: str, admin_id: int) -> Order:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            self._require_assigned_admin(order, admin_id)
            if order.status == OrderStatus.DELIVERED:
                return order
            artifacts = await uow.orders.list_artifacts(order.id)
            if not artifacts or any(item.delivered_at is None for item in artifacts):
                raise InvalidArtifact("Not every artifact has been delivered")
            previous, target = order.transition(OrderStatus.DELIVERED, at=self._clock.now())
            await uow.orders.save(order)
            await uow.orders.add_event(
                self._event(order, previous, target, ActorType.ADMIN, admin_id, "delivered")
            )
            await uow.commit()
            return order

    async def get_order(self, public_id: str) -> Order:
        async with self._uow_factory() as uow:
            return await self._require_order(uow, public_id)

    async def list_user_orders(self, telegram_user_id: int) -> list[Order]:
        async with self._uow_factory() as uow:
            return await uow.orders.list_for_user(telegram_user_id)

    async def list_active_orders(self) -> list[Order]:
        terminal = {OrderStatus.DELIVERED, OrderStatus.CANCELED}
        statuses = set(OrderStatus) - terminal
        async with self._uow_factory() as uow:
            return await uow.orders.list_by_statuses(statuses)

    async def list_artifacts(self, public_id: str) -> list[Artifact]:
        async with self._uow_factory() as uow:
            order = await self._require_order(uow, public_id)
            return await uow.orders.list_artifacts(order.id)

    async def _move_to_awaiting_source(
        self,
        uow: UnitOfWork,
        order: Order,
        reason: str,
        actor_type: ActorType,
        actor_id: int | None,
    ) -> None:
        # Both transitions are recorded deliberately: PAID is an auditable business fact,
        # AWAITING_SOURCE is the operational state.
        previous, target = order.transition(OrderStatus.PAID, at=self._clock.now())
        await uow.orders.save(order)
        await uow.orders.add_event(
            self._event(order, previous, target, actor_type, actor_id, reason)
        )
        previous, target = order.transition(OrderStatus.AWAITING_SOURCE, at=self._clock.now())
        await uow.orders.save(order)
        await uow.orders.add_event(
            self._event(order, previous, target, ActorType.SYSTEM, None, "awaiting_source")
        )

    async def _require_order(self, uow: UnitOfWork, public_id: str) -> Order:
        order = await uow.orders.get(public_id.upper())
        if order is None:
            raise OrderNotFound(f"Unknown order: {public_id}")
        return order

    async def _require_order_by_internal_id(self, uow: UnitOfWork, internal_id: str) -> Order:
        order = await uow.orders.get_by_internal_id(internal_id)
        if order is None:
            raise OrderNotFound(f"Unknown internal order: {internal_id}")
        return order

    def _event(
        self,
        order: Order,
        previous: OrderStatus | None,
        target: OrderStatus,
        actor_type: ActorType,
        actor_id: int | None,
        reason: str,
    ) -> OrderEvent:
        return OrderEvent(
            id=self._ids.uuid(),
            order_id=order.id,
            from_status=previous,
            to_status=target,
            actor_type=actor_type,
            actor_id=actor_id,
            reason=reason,
            created_at=self._clock.now(),
        )

    def _business_day_bounds(self, now: datetime) -> tuple[datetime, datetime]:
        local = now.astimezone(self._timezone)
        start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
        end_local = start_local + timedelta(days=1)
        return start_local.astimezone(UTC), end_local.astimezone(UTC)

    @staticmethod
    def _require_assigned_admin(order: Order, admin_id: int) -> None:
        if order.assigned_admin_id != admin_id:
            raise AccessDenied("Order is assigned to another administrator")

    @staticmethod
    def _require_unassigned_automation(order: Order) -> None:
        if order.status != OrderStatus.IN_PROGRESS or order.assigned_admin_id is not None:
            raise InvalidTransition("Order is not owned by the automated analysis worker")

    @staticmethod
    def _require_bundle(artifacts: list[Artifact], *, automated: bool) -> None:
        required = _AUTOMATED_DELIVERABLES if automated else REQUIRED_DELIVERABLES
        kinds = {artifact.kind for artifact in artifacts}
        missing = required - kinds
        if missing:
            names = ", ".join(sorted(item.value for item in missing))
            raise InvalidArtifact(f"Missing required deliverables: {names}")

    async def _store_artifact(
        self, uow: UnitOfWork, order: Order, delivery: DeliveryFile
    ) -> Artifact:
        stored = await self._storage.save(
            order_id=order.id,
            category="deliverables",
            filename=f"{delivery.kind.value}-{delivery.original_name}",
            content=delivery.content,
        )
        artifact = Artifact(
            id=self._ids.uuid(),
            order_id=order.id,
            kind=delivery.kind,
            storage_key=stored.key,
            original_name=delivery.original_name,
            checksum_sha256=stored.checksum_sha256,
            telegram_file_id=delivery.telegram_file_id,
            created_at=self._clock.now(),
        )
        persisted = await uow.orders.upsert_artifact(artifact)
        order.artifact_kinds.add(delivery.kind)
        await uow.orders.save(order)
        return persisted

    def _validate_delivery(self, delivery: DeliveryFile) -> None:
        if not delivery.content:
            raise InvalidArtifact("Deliverable is empty")
        self._validate_upload_size(delivery.content, artifact=True)
        if delivery.kind in {
            ArtifactKind.ERRORS_WHITE_PGN,
            ArtifactKind.ERRORS_BLACK_PGN,
            ArtifactKind.CONVERSION_WHITE_PGN,
            ArtifactKind.CONVERSION_BLACK_PGN,
        }:
            expected_orientation = (
                "white"
                if delivery.kind
                in {ArtifactKind.ERRORS_WHITE_PGN, ArtifactKind.CONVERSION_WHITE_PGN}
                else "black"
            )
            try:
                self._pgn_inspector.inspect(
                    delivery.content,
                    max_games=64,
                    allow_position_tasks=True,
                    expected_orientation=expected_orientation,
                )
            except InvalidSource as exc:
                raise InvalidArtifact(f"Invalid PGN deliverable: {exc}") from exc
        if delivery.kind in {ArtifactKind.REPORT_PDF, ArtifactKind.PLAN_14D}:
            if (
                not delivery.content.startswith(b"%PDF-")
                or b"%%EOF" not in delivery.content[-2048:]
            ):
                raise InvalidArtifact("PDF deliverable has an invalid signature")
        if delivery.kind == ArtifactKind.ANALYSIS_JSON:
            payload = self._analysis_payload(delivery.content)
            if payload.get("schema_version") != "1.0":
                raise InvalidArtifact("Analysis JSON has an unsupported schema")

    def _validate_delivery_for_order(self, order: Order, delivery: DeliveryFile) -> None:
        if delivery.kind != ArtifactKind.ANALYSIS_JSON:
            return
        payload = self._analysis_payload(delivery.content)
        subject = payload.get("subject")
        source_sha256 = payload.get("source_sha256")
        report_language = payload.get("report_language")
        if not isinstance(subject, str) or not order.player_name:
            raise InvalidArtifact("Analysis JSON has no valid subject")
        if subject.strip().casefold() != order.player_name.strip().casefold():
            raise InvalidArtifact("Analysis JSON belongs to another player")
        if order.source_checksum and source_sha256 != order.source_checksum:
            raise InvalidArtifact("Analysis JSON belongs to another PGN corpus")
        if report_language != order.report_language.value:
            raise InvalidArtifact("Analysis JSON has the wrong report language")

    @staticmethod
    def _analysis_payload(content: bytes) -> dict[str, object]:
        try:
            payload = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise InvalidArtifact("Analysis JSON is invalid") from exc
        if not isinstance(payload, dict):
            raise InvalidArtifact("Analysis JSON root must be an object")
        return payload

    def _validate_upload_size(self, content: bytes, *, artifact: bool = False) -> None:
        if len(content) > self._max_upload_bytes:
            noun = "Deliverable" if artifact else "Source file"
            message = f"{noun} exceeds the configured upload limit"
            if artifact:
                raise InvalidArtifact(message)
            raise InvalidSource(message)


def normalize_lichess_reference(value: str) -> str:
    candidate = value.strip().rstrip("/")
    prefixes = ("https://lichess.org/@/", "http://lichess.org/@/", "lichess.org/@/")
    for prefix in prefixes:
        if candidate.lower().startswith(prefix):
            candidate = candidate[len(prefix) :]
            break
    if not 2 <= len(candidate) <= 30:
        raise InvalidSource("Lichess username must contain 2–30 characters")
    if not all(ch.isalnum() or ch in "_-" for ch in candidate):
        raise InvalidSource("Invalid Lichess username or profile URL")
    return candidate
