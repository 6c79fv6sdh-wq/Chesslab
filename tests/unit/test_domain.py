from datetime import UTC, datetime

import pytest

from chess_dossier.domain.enums import OrderStatus, ReportLanguage, SourceType, TimeControl
from chess_dossier.domain.errors import InvalidTransition
from chess_dossier.domain.models import Order


def make_order() -> Order:
    now = datetime(2026, 8, 6, tzinfo=UTC)
    return Order(
        id="id",
        public_id="CD-1",
        telegram_user_id=1,
        status=OrderStatus.AWAITING_PAYMENT,
        source_type=SourceType.PGN,
        time_control=TimeControl.BLITZ,
        report_language=ReportLanguage.RU,
        contact="@u",
        price_minor=99_000,
        currency="RUB",
        idempotency_key="key",
        created_at=now,
        updated_at=now,
    )


def test_valid_transition_records_payment_time() -> None:
    order = make_order()
    at = datetime(2026, 8, 6, 1, tzinfo=UTC)
    order.transition(OrderStatus.PAID, at=at)
    assert order.status == OrderStatus.PAID
    assert order.paid_at == at


def test_invalid_transition_is_rejected() -> None:
    order = make_order()
    with pytest.raises(InvalidTransition):
        order.transition(OrderStatus.DELIVERED, at=datetime.now(UTC))
