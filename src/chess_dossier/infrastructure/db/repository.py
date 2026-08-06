from __future__ import annotations

from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from chess_dossier.domain.enums import (
    ArtifactKind,
    OrderStatus,
    PaymentProvider,
    PaymentStatus,
    ReportLanguage,
    SourceType,
    TimeControl,
)
from chess_dossier.domain.models import Artifact, Order, OrderEvent, Payment
from chess_dossier.infrastructure.db.models import (
    ArtifactRecord,
    OrderEventRecord,
    OrderRecord,
    PaymentRecord,
)


class SqlAlchemyOrderRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, order: Order) -> None:
        self._session.add(self._to_record(order))

    async def get(self, public_id: str) -> Order | None:
        return await self._one(select(OrderRecord).where(OrderRecord.public_id == public_id))

    async def get_by_internal_id(self, internal_id: str) -> Order | None:
        return await self._one(select(OrderRecord).where(OrderRecord.id == internal_id))

    async def get_by_idempotency_key(self, key: str) -> Order | None:
        return await self._one(select(OrderRecord).where(OrderRecord.idempotency_key == key))

    async def save(self, order: Order) -> None:
        record = await self._session.get(OrderRecord, order.id)
        if record is None:
            raise RuntimeError(f"Cannot save missing order {order.id}")
        self._apply(order, record)

    async def count_created_between(self, start: datetime, end: datetime) -> int:
        statement = select(func.count(OrderRecord.id)).where(
            OrderRecord.created_at >= start,
            OrderRecord.created_at < end,
            OrderRecord.status != OrderStatus.CANCELED.value,
        )
        return int((await self._session.scalar(statement)) or 0)

    async def list_for_user(self, telegram_user_id: int, limit: int = 10) -> list[Order]:
        statement = (
            select(OrderRecord)
            .where(OrderRecord.telegram_user_id == telegram_user_id)
            .order_by(OrderRecord.created_at.desc())
            .limit(limit)
        )
        return await self._many(statement)

    async def list_by_statuses(self, statuses: set[OrderStatus], limit: int = 20) -> list[Order]:
        statement = (
            select(OrderRecord)
            .where(OrderRecord.status.in_({status.value for status in statuses}))
            .order_by(OrderRecord.created_at.asc())
            .limit(limit)
        )
        return await self._many(statement)

    async def add_event(self, event: OrderEvent) -> None:
        self._session.add(
            OrderEventRecord(
                id=event.id,
                order_id=event.order_id,
                from_status=event.from_status.value if event.from_status else None,
                to_status=event.to_status.value,
                actor_type=event.actor_type.value,
                actor_id=event.actor_id,
                reason=event.reason,
                created_at=event.created_at,
            )
        )

    async def add_payment(self, payment: Payment) -> None:
        self._session.add(self._payment_to_record(payment))

    async def get_payment_by_payload(self, payload: str) -> Payment | None:
        statement = select(PaymentRecord).where(PaymentRecord.invoice_payload == payload)
        record = await self._session.scalar(statement)
        return self._payment_from_record(record) if record else None

    async def get_payment_by_charge(self, charge_id: str) -> Payment | None:
        statement = select(PaymentRecord).where(PaymentRecord.external_charge_id == charge_id)
        record = await self._session.scalar(statement)
        return self._payment_from_record(record) if record else None

    async def save_payment(self, payment: Payment) -> None:
        record = await self._session.get(PaymentRecord, payment.id)
        if record is None:
            raise RuntimeError(f"Cannot save missing payment {payment.id}")
        record.status = payment.status.value
        record.external_charge_id = payment.external_charge_id
        record.confirmed_at = payment.confirmed_at

    async def upsert_artifact(self, artifact: Artifact) -> Artifact:
        statement = select(ArtifactRecord).where(
            ArtifactRecord.order_id == artifact.order_id,
            ArtifactRecord.kind == artifact.kind.value,
        )
        record = await self._session.scalar(statement)
        if record is None:
            self._session.add(self._artifact_to_record(artifact))
            return artifact
        record.storage_key = artifact.storage_key
        record.original_name = artifact.original_name
        record.checksum_sha256 = artifact.checksum_sha256
        record.telegram_file_id = artifact.telegram_file_id
        record.created_at = artifact.created_at
        record.delivered_at = None
        return self._artifact_from_record(record)

    async def list_artifacts(self, order_id: str) -> list[Artifact]:
        statement = (
            select(ArtifactRecord)
            .where(ArtifactRecord.order_id == order_id)
            .order_by(ArtifactRecord.kind.asc())
        )
        records = list((await self._session.scalars(statement)).all())
        return [self._artifact_from_record(record) for record in records]

    async def mark_artifact_delivered(
        self, *, order_id: str, artifact_id: str, delivered_at: datetime
    ) -> bool:
        record = await self._session.get(ArtifactRecord, artifact_id)
        if record is None or record.order_id != order_id:
            return False
        record.delivered_at = delivered_at
        return True

    async def _one(self, statement: Select[tuple[OrderRecord]]) -> Order | None:
        record = await self._session.scalar(statement)
        if record is None:
            return None
        return await self._from_record(record)

    async def _many(self, statement: Select[tuple[OrderRecord]]) -> list[Order]:
        records = list((await self._session.scalars(statement)).all())
        return [await self._from_record(record) for record in records]

    async def _from_record(self, record: OrderRecord) -> Order:
        artifact_statement = select(ArtifactRecord.kind).where(ArtifactRecord.order_id == record.id)
        artifact_values = set((await self._session.scalars(artifact_statement)).all())
        return Order(
            id=record.id,
            public_id=record.public_id,
            telegram_user_id=record.telegram_user_id,
            status=OrderStatus(record.status),
            source_type=SourceType(record.source_type),
            time_control=TimeControl(record.time_control),
            report_language=ReportLanguage(record.report_language),
            contact=record.contact,
            rating=record.rating,
            player_name=record.player_name,
            price_minor=record.price_minor,
            currency=record.currency,
            idempotency_key=record.idempotency_key,
            source_reference=record.source_reference,
            source_storage_key=record.source_storage_key,
            source_original_name=record.source_original_name,
            source_file_unique_id=record.source_file_unique_id,
            source_checksum=record.source_checksum,
            game_count=record.game_count,
            assigned_admin_id=record.assigned_admin_id,
            failure_reason=record.failure_reason,
            version=record.version,
            created_at=record.created_at,
            updated_at=record.updated_at,
            paid_at=record.paid_at,
            queued_at=record.queued_at,
            delivered_at=record.delivered_at,
            artifact_kinds={ArtifactKind(value) for value in artifact_values},
        )

    @staticmethod
    def _to_record(order: Order) -> OrderRecord:
        record = OrderRecord(id=order.id)
        SqlAlchemyOrderRepository._apply(order, record)
        return record

    @staticmethod
    def _apply(order: Order, record: OrderRecord) -> None:
        record.public_id = order.public_id
        record.telegram_user_id = order.telegram_user_id
        record.status = order.status.value
        record.source_type = order.source_type.value
        record.time_control = order.time_control.value
        record.report_language = order.report_language.value
        record.contact = order.contact
        record.rating = order.rating
        record.player_name = order.player_name
        record.price_minor = order.price_minor
        record.currency = order.currency
        record.idempotency_key = order.idempotency_key
        record.source_reference = order.source_reference
        record.source_storage_key = order.source_storage_key
        record.source_original_name = order.source_original_name
        record.source_file_unique_id = order.source_file_unique_id
        record.source_checksum = order.source_checksum
        record.game_count = order.game_count
        record.assigned_admin_id = order.assigned_admin_id
        record.failure_reason = order.failure_reason
        record.version = order.version
        record.created_at = order.created_at
        record.updated_at = order.updated_at
        record.paid_at = order.paid_at
        record.queued_at = order.queued_at
        record.delivered_at = order.delivered_at

    @staticmethod
    def _payment_to_record(payment: Payment) -> PaymentRecord:
        return PaymentRecord(
            id=payment.id,
            order_id=payment.order_id,
            provider=payment.provider.value,
            status=payment.status.value,
            amount=payment.amount,
            currency=payment.currency,
            invoice_payload=payment.invoice_payload,
            external_charge_id=payment.external_charge_id,
            created_at=payment.created_at,
            confirmed_at=payment.confirmed_at,
        )

    @staticmethod
    def _payment_from_record(record: PaymentRecord) -> Payment:
        return Payment(
            id=record.id,
            order_id=record.order_id,
            provider=PaymentProvider(record.provider),
            status=PaymentStatus(record.status),
            amount=record.amount,
            currency=record.currency,
            invoice_payload=record.invoice_payload,
            external_charge_id=record.external_charge_id,
            created_at=record.created_at,
            confirmed_at=record.confirmed_at,
        )

    @staticmethod
    def _artifact_to_record(artifact: Artifact) -> ArtifactRecord:
        return ArtifactRecord(
            id=artifact.id,
            order_id=artifact.order_id,
            kind=artifact.kind.value,
            storage_key=artifact.storage_key,
            original_name=artifact.original_name,
            checksum_sha256=artifact.checksum_sha256,
            telegram_file_id=artifact.telegram_file_id,
            created_at=artifact.created_at,
            delivered_at=artifact.delivered_at,
        )

    @staticmethod
    def _artifact_from_record(record: ArtifactRecord) -> Artifact:
        return Artifact(
            id=record.id,
            order_id=record.order_id,
            kind=ArtifactKind(record.kind),
            storage_key=record.storage_key,
            original_name=record.original_name,
            checksum_sha256=record.checksum_sha256,
            telegram_file_id=record.telegram_file_id,
            created_at=record.created_at,
            delivered_at=record.delivered_at,
        )
