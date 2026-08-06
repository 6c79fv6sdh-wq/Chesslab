from __future__ import annotations

import pytest
from pydantic import ValidationError

from chess_dossier.config import Settings


def test_production_requires_explicit_runtime_dependencies() -> None:
    with pytest.raises(ValidationError):
        Settings(
            environment="production",
            telegram_bot_token="123456:abcdefghijklmnopqrstuvwxyzABCDE12345",
            admin_ids="1",
            payment_mode="telegram_stars",
            star_price=500,
        )


def test_valid_production_contract() -> None:
    settings = Settings(
        environment="production",
        telegram_bot_token="123456:abcdefghijklmnopqrstuvwxyzABCDE12345",
        admin_ids="1,2",
        payment_mode="telegram_stars",
        star_price=500,
        redis_url="redis://localhost:6379/0",
        support_contact="@real_support",
        auto_create_schema=False,
    )
    assert settings.admin_id_set == frozenset({1, 2})


def test_manual_payment_is_rejected_in_production() -> None:
    with pytest.raises(ValidationError):
        Settings(
            environment="production",
            telegram_bot_token="123456:abcdefghijklmnopqrstuvwxyzABCDE12345",
            admin_ids="1",
            payment_mode="manual",
            redis_url="redis://localhost:6379/0",
        )
