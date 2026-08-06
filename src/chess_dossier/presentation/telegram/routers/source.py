from __future__ import annotations

import io

from aiogram import Bot, F, Router
from aiogram.filters import StateFilter
from aiogram.types import Message

from chess_dossier.application.services import OrderService
from chess_dossier.config import Settings
from chess_dossier.domain.enums import OrderStatus, SourceType
from chess_dossier.domain.errors import DomainError
from chess_dossier.domain.models import Order
from chess_dossier.presentation.telegram.notifications import notify_admins
from chess_dossier.presentation.telegram.texts import admin_card

router = Router(name="source")


async def _pending_order(message: Message, order_service: OrderService) -> Order | None:
    if message.from_user is None:
        return None
    orders = await order_service.list_user_orders(message.from_user.id)
    return next((order for order in orders if order.status == OrderStatus.AWAITING_SOURCE), None)


@router.message(StateFilter(None), F.document)
async def receive_pgn(
    message: Message,
    order_service: OrderService,
    settings: Settings,
    bot: Bot,
) -> None:
    order = await _pending_order(message, order_service)
    if order is None or message.document is None or message.from_user is None:
        return
    if order.source_type == SourceType.LICHESS:
        await message.answer("Для этого дела нужен ник или ссылка Lichess, а не файл.")
        return
    filename = message.document.file_name or "games.pgn"
    if not filename.lower().endswith(".pgn"):
        await message.answer("Материалы отклонены: нужен файл с расширением .pgn.")
        return
    if message.document.file_size and message.document.file_size > settings.max_upload_bytes:
        await message.answer(
            f"Файл превышает лимит {settings.max_upload_bytes // (1024 * 1024)} МБ."
        )
        return
    buffer = io.BytesIO()
    await bot.download(message.document.file_id, destination=buffer)
    try:
        order = await order_service.submit_pgn(
            public_id=order.public_id,
            telegram_user_id=message.from_user.id,
            filename=filename,
            content=buffer.getvalue(),
            telegram_file_unique_id=message.document.file_unique_id,
        )
    except DomainError as exc:
        await message.answer(f"Материалы не приняты: {exc}")
        return
    await message.answer(
        f"Материалы приняты: <b>{order.game_count}</b> партий. "
        f"Дело <b>{order.public_id}</b> внесено в реестр производства."
    )
    await notify_admins(bot, settings.admin_id_set, admin_card(order))


@router.message(StateFilter(None), F.text)
async def receive_lichess_reference(
    message: Message,
    order_service: OrderService,
    settings: Settings,
    bot: Bot,
) -> None:
    if not message.text or message.text.startswith("/") or message.from_user is None:
        return
    order = await _pending_order(message, order_service)
    if order is None or order.source_type != SourceType.LICHESS:
        return
    try:
        order = await order_service.submit_lichess_reference(
            public_id=order.public_id,
            telegram_user_id=message.from_user.id,
            reference=message.text,
        )
    except DomainError as exc:
        await message.answer(f"Профиль не принят: {exc}")
        return
    await message.answer(
        f"Профиль <b>{order.source_reference}</b> зарегистрирован. "
        f"Дело <b>{order.public_id}</b> внесено в реестр производства."
    )
    await notify_admins(bot, settings.admin_id_set, admin_card(order))
