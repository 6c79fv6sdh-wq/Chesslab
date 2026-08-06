from __future__ import annotations

from enum import StrEnum


class OrderStatus(StrEnum):
    AWAITING_PAYMENT = "awaiting_payment"
    PAYMENT_REVIEW = "payment_review"
    PAID = "paid"
    AWAITING_SOURCE = "awaiting_source"
    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    REVIEW_PENDING = "review_pending"
    READY = "ready"
    DELIVERED = "delivered"
    FAILED = "failed"
    CANCELED = "canceled"


class SourceType(StrEnum):
    LICHESS = "lichess"
    PGN = "pgn"
    CHESSCOM_PGN = "chesscom_pgn"


class TimeControl(StrEnum):
    BLITZ = "blitz"
    RAPID = "rapid"
    BOTH = "both"


class ReportLanguage(StrEnum):
    RU = "ru"
    EN = "en"


class ArtifactKind(StrEnum):
    ANALYSIS_JSON = "analysis_json"
    REPORT_PDF = "report_pdf"
    ERRORS_WHITE_PGN = "errors_white_pgn"
    ERRORS_BLACK_PGN = "errors_black_pgn"
    CONVERSION_WHITE_PGN = "conversion_white_pgn"
    CONVERSION_BLACK_PGN = "conversion_black_pgn"
    PLAN_14D = "plan_14d"
    SUPPLEMENT = "supplement"


class PaymentProvider(StrEnum):
    TELEGRAM_STARS = "telegram_stars"
    MANUAL_ADMIN = "manual_admin"


class PaymentStatus(StrEnum):
    CREATED = "created"
    REPORTED = "reported"
    CONFIRMED = "confirmed"
    REFUNDED = "refunded"
    FAILED = "failed"


class ActorType(StrEnum):
    USER = "user"
    ADMIN = "admin"
    SYSTEM = "system"


ALLOWED_TRANSITIONS: dict[OrderStatus, frozenset[OrderStatus]] = {
    OrderStatus.AWAITING_PAYMENT: frozenset(
        {OrderStatus.PAYMENT_REVIEW, OrderStatus.PAID, OrderStatus.CANCELED}
    ),
    OrderStatus.PAYMENT_REVIEW: frozenset(
        {OrderStatus.AWAITING_PAYMENT, OrderStatus.PAID, OrderStatus.CANCELED}
    ),
    OrderStatus.PAID: frozenset({OrderStatus.AWAITING_SOURCE, OrderStatus.CANCELED}),
    OrderStatus.AWAITING_SOURCE: frozenset({OrderStatus.QUEUED, OrderStatus.CANCELED}),
    OrderStatus.QUEUED: frozenset(
        {OrderStatus.IN_PROGRESS, OrderStatus.FAILED, OrderStatus.CANCELED}
    ),
    OrderStatus.IN_PROGRESS: frozenset(
        {
            OrderStatus.REVIEW_PENDING,
            OrderStatus.READY,
            OrderStatus.QUEUED,
            OrderStatus.FAILED,
            OrderStatus.CANCELED,
        }
    ),
    OrderStatus.REVIEW_PENDING: frozenset(
        {OrderStatus.READY, OrderStatus.QUEUED, OrderStatus.FAILED, OrderStatus.CANCELED}
    ),
    OrderStatus.READY: frozenset(
        {OrderStatus.DELIVERED, OrderStatus.IN_PROGRESS, OrderStatus.FAILED}
    ),
    OrderStatus.FAILED: frozenset(
        {OrderStatus.QUEUED, OrderStatus.IN_PROGRESS, OrderStatus.CANCELED}
    ),
    OrderStatus.DELIVERED: frozenset(),
    OrderStatus.CANCELED: frozenset(),
}


REQUIRED_DELIVERABLES = frozenset(
    {
        ArtifactKind.REPORT_PDF,
        ArtifactKind.ERRORS_WHITE_PGN,
        ArtifactKind.ERRORS_BLACK_PGN,
        ArtifactKind.CONVERSION_WHITE_PGN,
        ArtifactKind.CONVERSION_BLACK_PGN,
    }
)
