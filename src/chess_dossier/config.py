from __future__ import annotations

from functools import cached_property
from pathlib import Path
from typing import Literal

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from chess_dossier.analysis.models import AnalysisConfig


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    telegram_bot_token: SecretStr | None = None
    admin_ids: str = ""
    support_contact: str = "@support"
    brand_name: str = "Чест-досье"

    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"

    database_url: str = "sqlite+aiosqlite:///./data/chess_dossier.db"
    storage_root: Path = Path("./data/storage")
    redis_url: str | None = None

    payment_mode: Literal["manual", "telegram_stars"] = "manual"
    star_price: int = 0
    display_price_rub: int = 990

    max_daily_orders: int = 3
    max_games_per_order: int = 50
    max_upload_bytes: int = 20 * 1024 * 1024
    delivery_hours: int = 24
    business_timezone: str = "Europe/Moscow"
    auto_create_schema: bool = False

    analysis_enabled: bool = False
    stockfish_path: Path = Path("/usr/games/stockfish")
    stockfish_threads: int = 1
    stockfish_hash_mb: int = 128
    analysis_fast_nodes: int = 12_000
    analysis_deep_nodes: int = 180_000
    analysis_candidate_loss_cp: int = 120
    analysis_max_critical_positions: int = 64
    analysis_max_conversion_positions: int = 20
    analysis_worker_poll_seconds: float = 10.0
    lichess_base_url: str = "https://lichess.org"
    lichess_api_token: SecretStr | None = None

    @cached_property
    def admin_id_set(self) -> frozenset[int]:
        if not self.admin_ids.strip():
            return frozenset()
        try:
            return frozenset(
                int(value.strip()) for value in self.admin_ids.split(",") if value.strip()
            )
        except ValueError as exc:
            raise ValueError("ADMIN_IDS must contain comma-separated integers") from exc

    @model_validator(mode="after")
    def validate_runtime_contract(self) -> Settings:
        if self.max_daily_orders < 1:
            raise ValueError("MAX_DAILY_ORDERS must be positive")
        if not 1 <= len(self.brand_name.strip()) <= 20:
            raise ValueError("BRAND_NAME must contain between 1 and 20 characters")
        if self.display_price_rub <= 0:
            raise ValueError("DISPLAY_PRICE_RUB must be positive")
        if self.delivery_hours <= 0:
            raise ValueError("DELIVERY_HOURS must be positive")
        if self.stockfish_threads < 1:
            raise ValueError("STOCKFISH_THREADS must be positive")
        if self.stockfish_hash_mb < 16:
            raise ValueError("STOCKFISH_HASH_MB must be at least 16")
        if self.analysis_fast_nodes < 1 or self.analysis_deep_nodes <= self.analysis_fast_nodes:
            raise ValueError("ANALYSIS_DEEP_NODES must be greater than ANALYSIS_FAST_NODES")
        if not 50 <= self.analysis_candidate_loss_cp <= 2_000:
            raise ValueError("ANALYSIS_CANDIDATE_LOSS_CP must be between 50 and 2000")
        if not 1 <= self.analysis_max_critical_positions <= 256:
            raise ValueError("ANALYSIS_MAX_CRITICAL_POSITIONS must be between 1 and 256")
        if not 1 <= self.analysis_max_conversion_positions <= 64:
            raise ValueError("ANALYSIS_MAX_CONVERSION_POSITIONS must be between 1 and 64")
        if self.analysis_worker_poll_seconds < 1:
            raise ValueError("ANALYSIS_WORKER_POLL_SECONDS must be at least 1")
        if self.analysis_enabled and not self.stockfish_path.is_file():
            raise ValueError(f"STOCKFISH_PATH does not point to a file: {self.stockfish_path}")
        if not 1 <= self.max_games_per_order <= 500:
            raise ValueError("MAX_GAMES_PER_ORDER must be between 1 and 500")
        if self.max_upload_bytes < 1024:
            raise ValueError("MAX_UPLOAD_BYTES is implausibly small")
        if self.payment_mode == "telegram_stars" and self.star_price <= 0:
            raise ValueError("STAR_PRICE must be positive in telegram_stars mode")
        if self.environment == "production":
            if not self.telegram_bot_token or not self.telegram_bot_token.get_secret_value():
                raise ValueError("TELEGRAM_BOT_TOKEN is required in production")
            if not self.redis_url:
                raise ValueError(
                    "REDIS_URL is required in production; MemoryStorage loses FSM state"
                )
            if not self.admin_ids.strip():
                raise ValueError("ADMIN_IDS is required in production")
            if not self.support_contact.strip() or self.support_contact == "@support":
                raise ValueError("SUPPORT_CONTACT must be configured in production")
            if self.payment_mode != "telegram_stars":
                raise ValueError("Production sales of a digital service must use Telegram Stars")
            if self.auto_create_schema:
                raise ValueError(
                    "AUTO_CREATE_SCHEMA must be false in production; run Alembic migrations"
                )
        return self

    @property
    def price_minor(self) -> int:
        return self.display_price_rub * 100

    @property
    def analysis_config(self) -> AnalysisConfig:
        return AnalysisConfig(
            fast_nodes=self.analysis_fast_nodes,
            deep_nodes=self.analysis_deep_nodes,
            candidate_loss_cp=self.analysis_candidate_loss_cp,
            max_critical_positions=self.analysis_max_critical_positions,
            max_conversion_positions=self.analysis_max_conversion_positions,
        )
