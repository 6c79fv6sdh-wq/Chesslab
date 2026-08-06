from __future__ import annotations

import pytest

from chess_dossier.application.dto import CreateOrderCommand, DeliveryFile
from chess_dossier.domain.enums import (
    ArtifactKind,
    OrderStatus,
    ReportLanguage,
    SourceType,
    TimeControl,
)
from chess_dossier.domain.errors import (
    AccessDenied,
    ActiveOrderExists,
    CapacityExceeded,
    InvalidArtifact,
    InvalidSource,
    PaymentError,
)


def command(key: str, user_id: int = 100) -> CreateOrderCommand:
    return CreateOrderCommand(
        telegram_user_id=user_id,
        source_type=SourceType.PGN,
        time_control=TimeControl.BLITZ,
        report_language=ReportLanguage.RU,
        contact="@tester",
        rating=1800,
        player_name="A",
        idempotency_key=key,
    )


@pytest.mark.asyncio
async def test_create_is_idempotent(service_bundle) -> None:
    first = await service_bundle.service.create_order(command("same"))
    second = await service_bundle.service.create_order(command("same"))
    assert first.id == second.id
    assert first.public_id == second.public_id


@pytest.mark.asyncio
async def test_daily_capacity(service_bundle) -> None:
    for index in range(3):
        await service_bundle.service.create_order(command(f"key-{index}", user_id=100 + index))
    with pytest.raises(CapacityExceeded):
        await service_bundle.service.create_order(command("overflow", user_id=999))


@pytest.mark.asyncio
async def test_only_one_active_order_per_user(service_bundle) -> None:
    await service_bundle.service.create_order(command("first"))
    with pytest.raises(ActiveOrderExists):
        await service_bundle.service.create_order(command("second"))


@pytest.mark.asyncio
async def test_full_manual_concierge_flow(service_bundle, valid_pgn: bytes) -> None:
    service = service_bundle.service
    order = await service.create_order(command("flow"))
    assert order.status == OrderStatus.AWAITING_PAYMENT

    order = await service.report_manual_payment(order.public_id, 100)
    assert order.status == OrderStatus.PAYMENT_REVIEW

    order = await service.confirm_manual_payment(order.public_id, 777)
    assert order.status == OrderStatus.AWAITING_SOURCE

    order = await service.submit_pgn(
        public_id=order.public_id,
        telegram_user_id=100,
        filename="games.pgn",
        content=valid_pgn,
        telegram_file_unique_id="tg-file-1",
    )
    assert order.status == OrderStatus.QUEUED
    assert order.game_count == 1

    order = await service.take_order(order.public_id, 777)
    assert order.status == OrderStatus.IN_PROGRESS

    files = {
        ArtifactKind.REPORT_PDF: "report.pdf",
        ArtifactKind.ERRORS_WHITE_PGN: "errors_WHITE.pgn",
        ArtifactKind.ERRORS_BLACK_PGN: "errors_BLACK.pgn",
        ArtifactKind.CONVERSION_WHITE_PGN: "conversion_WHITE.pgn",
        ArtifactKind.CONVERSION_BLACK_PGN: "conversion_BLACK.pgn",
    }
    for kind, filename in files.items():
        if kind == ArtifactKind.REPORT_PDF:
            content = b"%PDF-1.4\n%%EOF"
        else:
            orientation = (
                b"white"
                if kind in {ArtifactKind.ERRORS_WHITE_PGN, ArtifactKind.CONVERSION_WHITE_PGN}
                else b"black"
            )
            content = valid_pgn.replace(
                b'[Result "1-0"]',
                b'[Result "1-0"]\n[Orientation "' + orientation + b'"]',
            )
        await service.add_artifact(
            public_id=order.public_id,
            admin_id=777,
            delivery=DeliveryFile(kind=kind, original_name=filename, content=content),
        )

    order, artifacts = await service.prepare_delivery(order.public_id, 777)
    assert order.status == OrderStatus.READY
    assert len(artifacts) == 5

    for artifact in artifacts:
        await service.mark_artifact_delivered(
            public_id=order.public_id,
            artifact_id=artifact.id,
            admin_id=777,
        )

    order = await service.mark_delivered(order.public_id, 777)
    assert order.status == OrderStatus.DELIVERED


@pytest.mark.asyncio
async def test_delivery_requires_complete_bundle(service_bundle, valid_pgn: bytes) -> None:
    service = service_bundle.service
    order = await service.create_order(command("incomplete"))
    order = await service.confirm_manual_payment(order.public_id, 777)
    order = await service.submit_pgn(
        public_id=order.public_id,
        telegram_user_id=100,
        filename="games.pgn",
        content=valid_pgn,
        telegram_file_unique_id="tg-file-2",
    )
    await service.take_order(order.public_id, 777)
    await service.add_artifact(
        public_id=order.public_id,
        admin_id=777,
        delivery=DeliveryFile(
            kind=ArtifactKind.REPORT_PDF,
            original_name="report.pdf",
            content=b"%PDF-1.4\n%%EOF",
        ),
    )
    with pytest.raises(InvalidArtifact):
        await service.prepare_delivery(order.public_id, 777)


@pytest.mark.asyncio
async def test_stars_payment_is_validated_and_idempotent(service_bundle) -> None:
    service = service_bundle.service
    order = await service.create_order(command("stars"))
    payment = await service.prepare_stars_payment(order.public_id, 500)
    assert await service.validate_stars_payment(
        payload=payment.invoice_payload, amount=500, currency="XTR"
    )
    assert not await service.validate_stars_payment(
        payload=payment.invoice_payload, amount=501, currency="XTR"
    )
    paid = await service.confirm_stars_payment(
        payload=payment.invoice_payload,
        charge_id="stars-charge-1",
        amount=500,
        currency="XTR",
    )
    duplicate = await service.confirm_stars_payment(
        payload=payment.invoice_payload,
        charge_id="stars-charge-1",
        amount=500,
        currency="XTR",
    )
    assert paid.id == duplicate.id
    assert paid.status == OrderStatus.AWAITING_SOURCE

    with pytest.raises(PaymentError):
        await service.confirm_stars_payment(
            payload="tampered-payload",
            charge_id="stars-charge-1",
            amount=500,
            currency="XTR",
        )


@pytest.mark.asyncio
async def test_assigned_admin_owns_delivery(service_bundle, valid_pgn: bytes) -> None:
    service = service_bundle.service
    order = await service.create_order(command("assignment"))
    order = await service.confirm_manual_payment(order.public_id, 777)
    order = await service.submit_pgn(
        public_id=order.public_id,
        telegram_user_id=100,
        filename="games.pgn",
        content=valid_pgn,
        telegram_file_unique_id="tg-file-assignment",
    )
    await service.take_order(order.public_id, 777)

    with pytest.raises(AccessDenied):
        await service.take_order(order.public_id, 888)
    with pytest.raises(AccessDenied):
        await service.add_artifact(
            public_id=order.public_id,
            admin_id=888,
            delivery=DeliveryFile(
                kind=ArtifactKind.REPORT_PDF,
                original_name="report.pdf",
                content=b"%PDF-1.4\n%%EOF",
            ),
        )

    first = await service.add_artifact(
        public_id=order.public_id,
        admin_id=777,
        delivery=DeliveryFile(
            kind=ArtifactKind.REPORT_PDF,
            original_name="report-v1.pdf",
            content=b"%PDF-1.4\nversion one\n%%EOF",
        ),
    )
    replacement = await service.add_artifact(
        public_id=order.public_id,
        admin_id=777,
        delivery=DeliveryFile(
            kind=ArtifactKind.REPORT_PDF,
            original_name="report-v2.pdf",
            content=b"%PDF-1.4\nversion two\n%%EOF",
        ),
    )
    assert replacement.id == first.id
    assert replacement.checksum_sha256 != first.checksum_sha256


@pytest.mark.asyncio
async def test_invalid_or_oversized_artifacts_are_rejected(
    service_bundle, valid_pgn: bytes
) -> None:
    service = service_bundle.service
    order = await service.create_order(command("bad-artifacts"))
    order = await service.confirm_manual_payment(order.public_id, 777)
    order = await service.submit_pgn(
        public_id=order.public_id,
        telegram_user_id=100,
        filename="games.pgn",
        content=valid_pgn,
        telegram_file_unique_id="tg-file-bad-artifacts",
    )
    await service.take_order(order.public_id, 777)

    with pytest.raises(InvalidArtifact):
        await service.add_artifact(
            public_id=order.public_id,
            admin_id=777,
            delivery=DeliveryFile(
                kind=ArtifactKind.REPORT_PDF,
                original_name="report.pdf",
                content=b"not a pdf",
            ),
        )
    with pytest.raises(InvalidArtifact):
        await service.add_artifact(
            public_id=order.public_id,
            admin_id=777,
            delivery=DeliveryFile(
                kind=ArtifactKind.ERRORS_WHITE_PGN,
                original_name="errors_WHITE.pgn",
                content=b"not a pgn",
            ),
        )
    with pytest.raises(InvalidArtifact, match="another player"):
        await service.add_artifact(
            public_id=order.public_id,
            admin_id=777,
            delivery=DeliveryFile(
                kind=ArtifactKind.ANALYSIS_JSON,
                original_name="analysis.json",
                content=(
                    b'{"schema_version":"1.0","subject":"B",'
                    b'"source_sha256":"x","report_language":"ru"}'
                ),
            ),
        )

    with pytest.raises(InvalidSource):
        await service.submit_pgn(
            public_id=order.public_id,
            telegram_user_id=100,
            filename="oversized.pgn",
            content=b"x" * 1025,
            telegram_file_unique_id="oversized",
        )
