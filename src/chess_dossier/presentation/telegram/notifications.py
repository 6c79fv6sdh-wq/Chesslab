from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from html import escape

from aiogram import Bot

from chess_dossier.domain.models import Order

logger = logging.getLogger(__name__)


async def notify_admins(bot: Bot, admin_ids: frozenset[int], text: str) -> None:
    results = await asyncio.gather(
        *(bot.send_message(chat_id=admin_id, text=text) for admin_id in admin_ids),
        return_exceptions=True,
    )
    for admin_id, result in zip(admin_ids, results, strict=True):
        if isinstance(result, BaseException):
            logger.error("admin_notification_failed", extra={"admin_id": admin_id}, exc_info=result)


@dataclass(slots=True)
class TelegramAnalysisNotifier:
    bot: Bot
    admin_ids: frozenset[int]

    async def completed(self, order: Order) -> None:
        await self._send(
            order.telegram_user_id,
            f"Автоматическая экспертиза по делу <b>{escape(order.public_id)}</b> завершена. "
            "Комплект передан эксперту на обязательную проверку; после нее бот пришлет файлы.",
        )
        for admin_id in self.admin_ids:
            await self._send(
                admin_id,
                f"Дело <b>{escape(order.public_id)}</b> ожидает проверки. "
                f"Сначала <code>/preview {escape(order.public_id)}</code>, затем "
                f"<code>/deliver {escape(order.public_id)}</code> и <code>/done</code>.",
            )

    async def failed(self, order: Order) -> None:
        await self._send(
            order.telegram_user_id,
            f"Автоматическая экспертиза по делу <b>{escape(order.public_id)}</b> остановлена "
            "технической проверкой. Материалы сохранены; специалист разберет сбой вручную.",
        )
        reason = escape(order.failure_reason or "причина не записана")
        for admin_id in self.admin_ids:
            await self._send(
                admin_id,
                f"Дело <b>{escape(order.public_id)}</b> требует вмешательства.\n"
                f"<code>{reason}</code>\n"
                f"После исправления: <code>/retry {escape(order.public_id)}</code>.",
            )

    async def _send(self, chat_id: int, text: str) -> None:
        try:
            await self.bot.send_message(chat_id, text)
        except Exception:
            logger.exception("Could not send analysis notification to chat %s", chat_id)
