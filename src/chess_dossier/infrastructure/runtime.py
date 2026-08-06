from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

from chess_dossier.domain.enums import PaymentProvider
from chess_dossier.domain.models import Order


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class SecureIds:
    _alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

    def uuid(self) -> str:
        return str(uuid.uuid4())

    def public_order_id(self, now: datetime) -> str:
        suffix = "".join(secrets.choice(self._alphabet) for _ in range(6))
        return f"CD-{now:%Y%m%d}-{suffix}"

    def invoice_payload(self, order: Order, provider: PaymentProvider) -> str:
        return f"chess-dossier:{provider.value}:{order.id}"
