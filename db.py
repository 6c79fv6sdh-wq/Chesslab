"""Compatibility imports for the persistence adapter."""

from chess_dossier.infrastructure.db.database import (
    build_engine,
    build_session_factory,
    create_schema,
)

__all__ = ["build_engine", "build_session_factory", "create_schema"]
