"""Compatibility exports for Telegram feature routers."""

from chess_dossier.presentation.telegram.routers import admin, common, intake, payments, source

routers = (common.router, intake.router, payments.router, admin.router, source.router)

__all__ = ["routers"]
