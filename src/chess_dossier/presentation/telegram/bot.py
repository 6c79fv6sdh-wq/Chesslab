from __future__ import annotations

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.base import BaseStorage
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.fsm.storage.redis import RedisStorage
from aiogram.types import BotCommand, BotCommandScopeChat

from chess_dossier.bootstrap import Application
from chess_dossier.presentation.telegram.filters import IsAdmin
from chess_dossier.presentation.telegram.routers import admin, common, intake, payments, source


def build_fsm_storage(application: Application) -> BaseStorage:
    if application.settings.redis_url:
        return RedisStorage.from_url(application.settings.redis_url)
    return MemoryStorage()


def build_dispatcher(application: Application, storage: BaseStorage | None = None) -> Dispatcher:
    dispatcher = Dispatcher(storage=storage or build_fsm_storage(application))
    dispatcher["order_service"] = application.order_service
    dispatcher["settings"] = application.settings
    dispatcher["file_storage"] = application.file_storage

    admin.router.message.filter(IsAdmin(application.settings.admin_id_set))
    dispatcher.include_routers(
        common.router,
        intake.router,
        payments.router,
        admin.router,
        source.router,
    )
    return dispatcher


def build_bot(application: Application) -> Bot:
    token = application.settings.telegram_bot_token
    if token is None or not token.get_secret_value():
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not configured")
    return Bot(
        token=token.get_secret_value(),
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )


async def register_commands(bot: Bot, admin_ids: frozenset[int]) -> None:
    commands = [
        BotCommand(command="start", description="Открыть картотеку"),
        BotCommand(command="terms", description="Регламент"),
        BotCommand(command="support", description="Поддержка"),
        BotCommand(command="cancel", description="Отменить текущий ввод"),
    ]
    await bot.set_my_commands(commands)
    admin_commands = [
        *commands,
        BotCommand(command="admin", description="Реестр активных дел"),
        BotCommand(command="order", description="Карточка дела"),
        BotCommand(command="paid", description="Подтвердить оплату"),
        BotCommand(command="take", description="Принять дело"),
        BotCommand(command="preview", description="Проверить автокомплект"),
        BotCommand(command="retry", description="Перезапустить экспертизу"),
        BotCommand(command="deliver", description="Начать выдачу"),
    ]
    for admin_id in admin_ids:
        await bot.set_my_commands(admin_commands, scope=BotCommandScopeChat(chat_id=admin_id))
